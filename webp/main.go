package main

import (
	"archive/zip"
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/davidbyttow/govips/v2/vips"
	"github.com/gosimple/slug"
	"github.com/lithammer/shortuuid"
)

// List of extensions we accept as valid input
var supportedInputFormats = map[string]bool{
	"jpg": true, "jpeg": true, "png": true, "apng": true,
	"gif": true, "webp": true, "avif": true, "heic": true,
	"heif": true, "tiff": true, "tif": true, "bmp": true,
	"mp4": true, "mov": true, "webm": true, "mkv": true, "avi": true,
}

func main() {
	// Initialize libvips
	vips.Startup(&vips.Config{
		ConcurrencyLevel: 0,
		CacheTrace:       false,
		CollectStats:     false,
	})
	defer vips.Shutdown()

	// Routes
	http.HandleFunc("/", handleIndex)              // UI
	http.HandleFunc("/info", handleInfo)           // Basic info of the image
	http.HandleFunc("/convert", handleConvert)     // Always WebP
	http.HandleFunc("/thumbnail", handleThumbnail) // Scale + WebP
	http.HandleFunc("/bulk", handleBulk)           // Zip -> WebP Zip
	http.HandleFunc("/slug", handleSlug)           // Generate slugs

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	fmt.Printf("WebP Server running on port %s...\n", port)
	if err := http.ListenAndServe(":"+port, nil); err != nil {
		fmt.Printf("Server failed: %v\n", err)
	}
}

// ---------------- Handlers ----------------

func handleIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html")
	w.Write([]byte(htmlContent))
}

// POST /info - Returns metadata
func handleInfo(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Read bytes explicitly to compute hash
	buf, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Failed to read body", http.StatusBadRequest)
		return
	}

	// Compute SHA256 Hash
	hash := sha256.Sum256(buf)
	hashString := hex.EncodeToString(hash[:])

	// Load into vips
	params := vips.NewImportParams()
	params.NumPages.Set(-1)
	img, err := vips.LoadImageFromBuffer(buf, params)
	if err != nil {
		http.Error(w, "Failed to load image", http.StatusBadRequest)
		return
	}
	defer img.Close()

	width := img.Width()
	height := img.PageHeight()
	pages := img.Metadata().Pages
	isAnimated := pages > 1
	format := strings.ToLower(vips.ImageTypes[img.Metadata().Format])

	mimeType := "application/octet-stream"
	switch format {
	case "jpeg", "jpg":
		mimeType = "image/jpeg"
	case "png", "apng":
		mimeType = "image/png"
	case "webp":
		mimeType = "image/webp"
	case "gif":
		mimeType = "image/gif"
	case "avif":
		mimeType = "image/avif"
	case "heic", "heif":
		mimeType = "image/heif"
	case "tiff", "tif":
		mimeType = "image/tiff"
	case "bmp":
		mimeType = "image/bmp"
	case "svg":
		mimeType = "image/svg+xml"
	}

	resp := map[string]interface{}{
		"width":       width,
		"height":      height,
		"format":      format,
		"mime_type":   mimeType,
		"hash":        hashString,
		"is_animated": isAnimated,
		"pages":       pages,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// POST /convert - Converts input to WebP (Preserves Animation)
func handleConvert(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	contentType := r.Header.Get("Content-Type")
	img, err := loadImage(r.Body, contentType)
	if err != nil {
		http.Error(w, "Failed to load image", http.StatusBadRequest)
		return
	}
	defer img.Close()

	sendWebP(w, img)
}

// POST /thumbnail?height=X - Converts to WebP and scales down
func handleThumbnail(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	heightStr := r.URL.Query().Get("height")
	targetHeight, err := strconv.Atoi(heightStr)
	if err != nil || targetHeight <= 0 {
		http.Error(w, "Invalid height parameter", http.StatusBadRequest)
		return
	}

	contentType := r.Header.Get("Content-Type")
	img, err := loadImage(r.Body, contentType)
	if err != nil {
		http.Error(w, "Failed to load image", http.StatusBadRequest)
		return
	}
	defer img.Close()

	currentHeight := img.PageHeight()
	if currentHeight > targetHeight {
		scale := float64(targetHeight) / float64(currentHeight)

		if err := img.Resize(scale, vips.KernelLanczos3); err != nil {
			http.Error(w, "Failed to resize", http.StatusInternalServerError)
			return
		}

		if img.Metadata().Pages > 1 {
			if err := img.SetPageHeight(targetHeight); err != nil {
				fmt.Printf("Warning: Failed to set page height: %v\n", err)
			}
		}
	}

	sendWebP(w, img)
}

// POST /bulk?height=X(optional) - Zip in, Zip out (All converted to WebP)
func handleBulk(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	targetHeight := 0
	if hStr := r.URL.Query().Get("height"); hStr != "" {
		h, err := strconv.Atoi(hStr)
		if err == nil {
			targetHeight = h
		}
	}

	// Stream upload to temp file
	tmpFile, err := os.CreateTemp("", "bulk-upload-*.zip")
	if err != nil {
		http.Error(w, "Server error", http.StatusInternalServerError)
		return
	}
	defer os.Remove(tmpFile.Name())
	defer tmpFile.Close()

	if _, err := io.Copy(tmpFile, r.Body); err != nil {
		http.Error(w, "Upload failed", http.StatusInternalServerError)
		return
	}

	// Open Zip
	fi, _ := tmpFile.Stat()
	zipReader, err := zip.NewReader(tmpFile, fi.Size())
	if err != nil {
		http.Error(w, "Invalid zip file", http.StatusBadRequest)
		return
	}

	// Stream Output Zip
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", "attachment; filename=\"converted_webp.zip\"")

	zipWriter := zip.NewWriter(w)
	defer zipWriter.Close()

	for _, file := range zipReader.File {
		ext := strings.ToLower(filepath.Ext(file.Name))
		if len(ext) > 1 {
			ext = ext[1:] // remove dot
		}

		if file.FileInfo().IsDir() || !supportedInputFormats[ext] {
			copyZipEntry(zipWriter, file, file.Name)
			continue
		}

		processedBytes, err := processImageToWebP(file, targetHeight)
		if err != nil {
			fmt.Printf("Failed to process %s: %v. Copying original.\n", file.Name, err)
			copyZipEntry(zipWriter, file, file.Name)
			continue
		}

		nameWithoutExt := strings.TrimSuffix(file.Name, filepath.Ext(file.Name))
		newName := nameWithoutExt + ".webp"

		writer, err := zipWriter.Create(newName)
		if err == nil {
			writer.Write(processedBytes)
		}
	}
}

// GET /slug - Generate slugs
func handleSlug(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	name := r.URL.Query().Get("name")
	if name == "" {
		http.Error(w, "Name is required", http.StatusBadRequest)
		return
	}

	slugName := slug.Make(name)

	b := make([]byte, 2)
	rand.Read(b)
	hexStr := hex.EncodeToString(b)
	slugWithHex := fmt.Sprintf("%s-%s", slugName, strings.ToUpper(hexStr))

	shortID := shortuuid.New()

	resp := map[string]string{
		"slug":       slugName,
		"slug_hex":   slugWithHex,
		"short_uuid": shortID,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// ---------------- Helpers ----------------

func extractVideoFrame(vidBuf []byte) ([]byte, error) {
	cmd := exec.Command("ffmpeg", "-y", "-i", "pipe:0", "-frames:v", "1", "-c:v", "png", "-f", "image2", "-")
	cmd.Stdin = bytes.NewReader(vidBuf)

	var out bytes.Buffer
	cmd.Stdout = &out

	err := cmd.Run()
	if err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func loadImage(r io.Reader, contentType string) (*vips.ImageRef, error) {
	buf, err := io.ReadAll(r)
	if err != nil {
		return nil, err
	}

	if strings.HasPrefix(contentType, "video/") || (len(buf) > 8 && string(buf[4:8]) == "ftyp") {
		frameBuf, err := extractVideoFrame(buf)
		if err == nil && len(frameBuf) > 0 {
			buf = frameBuf
		} else {
			fmt.Printf("Warning: Failed to extract frame with ffmpeg: %v\n", err)
		}
	}

	params := vips.NewImportParams()
	params.NumPages.Set(-1)
	return vips.LoadImageFromBuffer(buf, params)
}

func sendWebP(w http.ResponseWriter, img *vips.ImageRef) {
	bytes, err := exportToWebP(img)
	if err != nil {
		http.Error(w, fmt.Sprintf("Export error: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "image/webp")
	w.Header().Set("Content-Length", strconv.Itoa(len(bytes)))
	w.Write(bytes)
}

func exportToWebP(img *vips.ImageRef) ([]byte, error) {
	p := vips.NewWebpExportParams()
	p.Quality = 75
	p.ReductionEffort = 4

	bytes, _, err := img.ExportWebp(p)
	return bytes, err
}

func processImageToWebP(file *zip.File, targetHeight int) ([]byte, error) {
	rc, err := file.Open()
	if err != nil {
		return nil, err
	}
	defer rc.Close()

	buf, err := io.ReadAll(rc)
	if err != nil {
		return nil, err
	}

	params := vips.NewImportParams()
	params.NumPages.Set(-1)
	img, err := vips.LoadImageFromBuffer(buf, params)
	if err != nil {
		return nil, err
	}
	defer img.Close()

	if targetHeight > 0 && img.PageHeight() > targetHeight {
		scale := float64(targetHeight) / float64(img.PageHeight())
		if err := img.Resize(scale, vips.KernelLanczos3); err != nil {
			return nil, err
		}
		if img.Metadata().Pages > 1 {
			img.SetPageHeight(targetHeight)
		}
	}

	return exportToWebP(img)
}

func copyZipEntry(zw *zip.Writer, file *zip.File, name string) {
	rc, _ := file.Open()
	defer rc.Close()
	w, _ := zw.Create(name)
	io.Copy(w, rc)
}

// ---------------- HTML Content ----------------

const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WebP Converter</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; line-height: 1.6; color: #333; }
        h1 { border-bottom: 2px solid #eee; padding-bottom: 10px; }
        .drop-zone { border: 2px dashed #ccc; border-radius: 8px; padding: 40px; text-align: center; cursor: pointer; transition: background 0.2s, border-color 0.2s; background: #fafafa; }
        .drop-zone:hover, .drop-zone.dragover { border-color: #666; background: #f0f0f0; }
        .drop-zone p { margin: 0; font-size: 1.1em; color: #666; }
        #fileInput { display: none; }
        .controls { margin-top: 20px; display: flex; gap: 10px; flex-wrap: wrap; }
        button { padding: 10px 20px; font-size: 1em; cursor: pointer; background: #007bff; color: white; border: none; border-radius: 4px; transition: background 0.2s; }
        button:hover { background: #0056b3; }
        button:disabled { background: #ccc; cursor: not-allowed; }
        .secondary { background: #6c757d; }
        .secondary:hover { background: #5a6268; }
        input[type="number"] { padding: 10px; width: 80px; border: 1px solid #ddd; border-radius: 4px; }
        #output { margin-top: 30px; border-top: 1px solid #eee; padding-top: 20px; }
        pre { background: #f4f4f4; padding: 15px; border-radius: 4px; overflow-x: auto; }
        .status { margin-top: 10px; font-weight: bold; }
    </style>
</head>
<body>
    <h1>WebP Converter</h1>
    
    <div class="drop-zone" id="dropZone">
        <p>Drag & drop an image or Zip file here<br>or click to select</p>
        <input type="file" id="fileInput" multiple>
    </div>

    <div class="controls">
        <input type="number" id="heightInput" placeholder="Height" value="200" title="Target height for thumbnail/bulk">
        <button onclick="process('info')" class="secondary">Get Info</button>
        <button onclick="process('convert')">Convert to WebP</button>
        <button onclick="process('thumbnail')">Generate Thumbnail</button>
        <button onclick="process('bulk')" style="background-color: #28a745;">Batch Zip</button>
    </div>

    <div id="status" class="status"></div>
    <div id="output"></div>

    <hr style="margin: 40px 0; border: none; border-top: 1px solid #eee;">
    
    <h2>Name Generator</h2>
    <div class="controls">
        <input type="text" id="emoteNameInput" placeholder="Enter name" style="flex: 1; padding: 10px; border: 1px solid #ddd; border-radius: 4px;">
        <button onclick="generateNames()">Generate</button>
    </div>
    <div id="nameStatus" class="status"></div>
    <div id="nameOutput" style="margin-top: 20px; border-top: 1px solid #eee; padding-top: 20px; border-top-color: transparent;"></div>

    <script>
        const dropZone = document.getElementById('dropZone');
        const fileInput = document.getElementById('fileInput');
        let selectedFile = null;

        // Drag & Drop
        dropZone.addEventListener('click', () => fileInput.click());
        dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
        dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.classList.remove('dragover');
            handleFile(e.dataTransfer.files[0]);
        });
        fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));

        function handleFile(file) {
            if (!file) return;
            selectedFile = file;
            document.getElementById('status').innerText = "Selected: " + file.name + " (" + (file.size/1024).toFixed(1) + " KB)";
            document.getElementById('output').innerHTML = '';
        }

        async function process(action) {
            if (!selectedFile) {
                alert("Please select a file first.");
                return;
            }

            const status = document.getElementById('status');
            const output = document.getElementById('output');
            status.innerText = "Processing...";
            output.innerHTML = '';

            let url = "/" + action;
            const height = document.getElementById('heightInput').value;

            // URL Params
            if (action === 'thumbnail' || action === 'bulk') {
                url += "?height=" + height;
            }

            try {
                const response = await fetch(url, {
                    method: 'POST',
                    body: selectedFile
                });

                if (!response.ok) {
                    throw new Error(await response.text());
                }

                // Handle Info (JSON)
                if (action === 'info') {
                    const data = await response.json();
                    status.innerText = "Done.";
                    output.innerHTML = '<pre>' + JSON.stringify(data, null, 2) + '</pre>';
                    return;
                }

                // Handle Downloads (Blob)
                const blob = await response.blob();
                const downloadUrl = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = downloadUrl;
                
                // Determine filename
                let newName = selectedFile.name;
                const dotIndex = newName.lastIndexOf('.');
                if (dotIndex !== -1) newName = newName.substring(0, dotIndex);
                
                if (action === 'bulk') {
                    a.download = "converted_webp.zip";
                } else {
                    a.download = newName + ".webp";
                }

                document.body.appendChild(a);
                a.click();
                a.remove();
                window.URL.revokeObjectURL(downloadUrl);
                status.innerText = "Download started!";

            } catch (err) {
                status.innerText = "Error: " + err.message;
                status.style.color = "red";
            }
        }

        async function generateNames() {
            const name = document.getElementById('emoteNameInput').value;
            if (!name) {
                alert("Please enter a name.");
                return;
            }

            const status = document.getElementById('nameStatus');
            const output = document.getElementById('nameOutput');
            status.innerText = "Generating...";
            output.innerHTML = '';

            try {
                const response = await fetch('/slug?name=' + encodeURIComponent(name));
                if (!response.ok) {
                    throw new Error(await response.text());
                }
                const data = await response.json();
                status.innerText = "Done.";
                output.innerHTML = '<pre>' + JSON.stringify(data, null, 2) + '</pre>';
            } catch (err) {
                status.innerText = "Error: " + err.message;
                status.style.color = "red";
            }
        }
    </script>
</body>
</html>
`
