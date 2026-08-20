package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

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

// ---------------- Configuration ----------------

const (
	maxZipEntries = 5000
	ffmpegTimeout = 30 * time.Second
)

var (
	maxUploadBytes int64         = 25 * 1024 * 1024 // override via MAX_UPLOAD_MB
	webpQuality                  = 75               // override via WEBP_QUALITY (1-100)
	webpEffort                   = 4                // override via WEBP_EFFORT (0-6)
	convertSem     chan struct{}                    // caps concurrent heavy conversions
)

func loadConfig() {
	if v := os.Getenv("MAX_UPLOAD_MB"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			maxUploadBytes = int64(n) * 1024 * 1024
		}
	}
	if v := os.Getenv("WEBP_QUALITY"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 1 && n <= 100 {
			webpQuality = n
		}
	}
	if v := os.Getenv("WEBP_EFFORT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 && n <= 6 {
			webpEffort = n
		}
	}
	if v := os.Getenv("MAX_ANIM_FRAMES"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			maxAnimationFrames = n
		}
	}
	if v := os.Getenv("MAX_ANIM_PIXELS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			maxFilmstripPixels = n
		}
	}
	concurrency := runtime.NumCPU()
	if v := os.Getenv("MAX_CONCURRENCY"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			concurrency = n
		}
	}
	convertSem = make(chan struct{}, concurrency)
	log.Printf("config: maxUpload=%dMB webpQuality=%d webpEffort=%d maxConcurrency=%d maxAnimFrames=%d maxAnimPixels=%d",
		maxUploadBytes/(1024*1024), webpQuality, webpEffort, concurrency, maxAnimationFrames, maxFilmstripPixels)
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	// Health-check mode (used by the container HEALTHCHECK); runs before vips init.
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(runHealthCheck(port))
	}

	loadConfig()

	vipsConcurrency := 0 // 0 => libvips default (threads per operation)
	if v := os.Getenv("VIPS_CONCURRENCY"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			vipsConcurrency = n
		}
	}
	vips.Startup(&vips.Config{
		ConcurrencyLevel: vipsConcurrency,
		CacheTrace:       false,
		CollectStats:     false,
	})
	defer vips.Shutdown()

	mux := http.NewServeMux()
	mux.HandleFunc("/", handleIndex)        // UI
	mux.HandleFunc("/health", handleHealth) // Liveness probe
	mux.HandleFunc("/info", limit(handleInfo))
	mux.HandleFunc("/convert", limit(handleConvert))
	mux.HandleFunc("/thumbnail", limit(handleThumbnail))
	mux.HandleFunc("/strip", limit(handleStrip))
	mux.HandleFunc("/bulk", limit(handleBulk))
	mux.HandleFunc("/slug", handleSlug)
	mux.HandleFunc("/formats", handleFormats)

	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           logRequests(mux),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      5 * time.Minute,
		IdleTimeout:       120 * time.Second,
	}

	// Graceful shutdown so in-flight conversions drain and vips.Shutdown runs.
	done := make(chan struct{})
	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
		<-sig
		log.Println("shutdown signal received; draining connections...")
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := srv.Shutdown(ctx); err != nil {
			log.Printf("graceful shutdown error: %v", err)
		}
		close(done)
	}()

	log.Printf("WebP server running on port %s", port)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("server failed: %v", err)
	}
	<-done
	log.Println("server stopped")
}

// limit caps concurrent CPU/memory-heavy conversions to protect the host.
func limit(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		convertSem <- struct{}{}
		defer func() { <-convertSem }()
		h(w, r)
	}
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

func logRequests(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		h.ServeHTTP(rec, r)
		log.Printf("%s %s %d %s", r.Method, r.URL.Path, rec.status, time.Since(start).Round(time.Millisecond))
	})
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"status":"ok"}`))
}

// runHealthCheck performs a one-shot GET /health for the container HEALTHCHECK.
func runHealthCheck(port string) int {
	client := http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://127.0.0.1:" + port + "/health")
	if err != nil {
		fmt.Fprintf(os.Stderr, "healthcheck failed: %v\n", err)
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		fmt.Fprintf(os.Stderr, "healthcheck got status %d\n", resp.StatusCode)
		return 1
	}
	return 0
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

	buf, ok := readLimitedBody(w, r)
	if !ok {
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
	format := strings.ToLower(vips.ImageTypes[img.Metadata().Format])
	if pages <= 1 && sniffAnimated(buf) {
		// APNG and animated AVIF look like stills to libvips; ask ffmpeg.
		if frames, err := countAnimationFrames(buf); err == nil {
			pages = frames
			if format == "png" {
				format = "apng"
			}
		} else {
			log.Printf("warning: could not count frames: %v", err)
		}
	}
	isAnimated := pages > 1

	metadataFound := detectMetadata(buf)

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
		"width":            width,
		"height":           height,
		"format":           format,
		"mime_type":        mimeType,
		"hash":             hashString,
		"is_animated":      isAnimated,
		"pages":            pages,
		"orientation":      img.Orientation(),
		"has_icc_profile":  img.HasICCProfile(),
		"has_metadata":     len(metadataFound) > 0,
		"metadata_removed": metadataFound,
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

	buf, ok := readLimitedBody(w, r)
	if !ok {
		return
	}
	img, err := loadImage(buf, r.Header.Get("Content-Type"), 0)
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

	buf, ok := readLimitedBody(w, r)
	if !ok {
		return
	}
	img, err := loadImage(buf, r.Header.Get("Content-Type"), targetHeight)
	if err != nil {
		http.Error(w, "Failed to load image", http.StatusBadRequest)
		return
	}
	defer img.Close()

	if err := scaleToHeight(img, targetHeight); err != nil {
		http.Error(w, "Failed to resize", http.StatusInternalServerError)
		return
	}

	sendWebP(w, img)
}

// POST /strip - Removes EXIF and other descriptive metadata, returning the
// image in its original format with its pixels untouched. Details of what was
// removed come back in X-Strip-* headers so a caller can log or skip a
// no-op result.
func handleStrip(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	buf, ok := readLimitedBody(w, r)
	if !ok {
		return
	}

	out, report, err := stripMetadata(buf)
	if err != nil {
		http.Error(w, fmt.Sprintf("Strip failed: %v", err), http.StatusBadRequest)
		return
	}
	if report.Note != "" {
		log.Printf("strip: %s (%s)", report.Note, report.Format)
	}

	contentType := r.Header.Get("Content-Type")
	if contentType == "" || contentType == "application/octet-stream" {
		contentType = mimeForFormat(report.Format)
	}

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Strip-Format", report.Format)
	w.Header().Set("X-Strip-Changed", strconv.FormatBool(report.Changed))
	w.Header().Set("X-Strip-Verified", strconv.FormatBool(report.Verified))
	w.Header().Set("X-Strip-Removed", joinLabels(report.Removed))
	if report.Note != "" {
		w.Header().Set("X-Strip-Note", report.Note)
	}
	w.Header().Set("Content-Length", strconv.Itoa(len(out)))
	w.Write(out)
}

func mimeForFormat(format string) string {
	switch format {
	case "jpeg":
		return "image/jpeg"
	case "png":
		return "image/png"
	case "webp":
		return "image/webp"
	case "gif":
		return "image/gif"
	case "isobmff":
		return "image/avif"
	case "tiff":
		return "image/tiff"
	case "bmp":
		return "image/bmp"
	}
	return "application/octet-stream"
}

// POST /bulk?height=X(optional) - Zip in, Zip out (All converted to WebP)
func handleBulk(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	targetHeight := 0
	if hStr := r.URL.Query().Get("height"); hStr != "" {
		if h, err := strconv.Atoi(hStr); err == nil {
			targetHeight = h
		}
	}

	// Stream the (size-capped) upload to a temp file.
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes)
	tmpFile, err := os.CreateTemp("", "bulk-upload-*.zip")
	if err != nil {
		http.Error(w, "Server error", http.StatusInternalServerError)
		return
	}
	defer os.Remove(tmpFile.Name())
	defer tmpFile.Close()

	if _, err := io.Copy(tmpFile, r.Body); err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			http.Error(w, fmt.Sprintf("Payload too large (max %d MB)", maxUploadBytes/(1024*1024)), http.StatusRequestEntityTooLarge)
		} else {
			http.Error(w, "Upload failed", http.StatusInternalServerError)
		}
		return
	}

	fi, err := tmpFile.Stat()
	if err != nil {
		http.Error(w, "Server error", http.StatusInternalServerError)
		return
	}
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

	processed := 0
	for _, file := range zipReader.File {
		if processed >= maxZipEntries {
			log.Printf("bulk: entry limit (%d) reached; skipping remaining entries", maxZipEntries)
			break
		}
		processed++

		// Guard against decompression bombs using the declared uncompressed size.
		if file.UncompressedSize64 > uint64(maxUploadBytes) {
			log.Printf("bulk: skipping oversized entry %s (%d bytes uncompressed)", file.Name, file.UncompressedSize64)
			continue
		}

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
			log.Printf("bulk: failed to process %s: %v; copying original", file.Name, err)
			copyZipEntry(zipWriter, file, file.Name)
			continue
		}

		newName := strings.TrimSuffix(file.Name, filepath.Ext(file.Name)) + ".webp"
		if writer, err := zipWriter.Create(newName); err == nil {
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
	if _, err := rand.Read(b); err != nil {
		http.Error(w, "Failed to generate slug", http.StatusInternalServerError)
		return
	}
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

// GET /formats - List supported input file extensions
func handleFormats(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	formats := make([]string, 0, len(supportedInputFormats))
	for k := range supportedInputFormats {
		formats = append(formats, k)
	}
	sort.Strings(formats)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"formats": formats})
}

// ---------------- Helpers ----------------

// readLimitedBody reads the request body up to maxUploadBytes, writing the
// appropriate error response (413/400) and returning ok=false on failure.
func readLimitedBody(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes)
	buf, err := io.ReadAll(r.Body)
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			http.Error(w, fmt.Sprintf("Payload too large (max %d MB)", maxUploadBytes/(1024*1024)), http.StatusRequestEntityTooLarge)
		} else {
			http.Error(w, "Failed to read body", http.StatusBadRequest)
		}
		return nil, false
	}
	return buf, true
}

// looksLikeVideo decides whether to run an ffmpeg frame-extraction pass before
// handing bytes to libvips, using the Content-Type plus common container magic.
func looksLikeVideo(buf []byte, contentType string) bool {
	if strings.HasPrefix(contentType, "video/") {
		return true
	}
	if len(buf) >= 12 {
		if string(buf[4:8]) == "ftyp" { // MP4 / MOV / ISO-BMFF
			// AVIF and HEIC share the container with MP4. Handing them to
			// ffmpeg would flatten them to a single frame, so let libvips (and
			// the animated-image path) have them instead.
			return !isISOBMFFImage(buf)
		}
		if buf[0] == 0x1A && buf[1] == 0x45 && buf[2] == 0xDF && buf[3] == 0xA3 { // Matroska / WebM
			return true
		}
		if string(buf[0:4]) == "RIFF" && string(buf[8:12]) == "AVI " { // AVI
			return true
		}
	}
	return false
}

func extractVideoFrame(vidBuf []byte) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), ffmpegTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "ffmpeg", "-y", "-i", "pipe:0", "-frames:v", "1", "-c:v", "png", "-f", "image2", "-")
	cmd.Stdin = bytes.NewReader(vidBuf)

	var out bytes.Buffer
	cmd.Stdout = &out

	if err := cmd.Run(); err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return nil, fmt.Errorf("ffmpeg timed out after %s", ffmpegTimeout)
		}
		return nil, err
	}
	return out.Bytes(), nil
}

// loadImage decodes an upload into a libvips image, keeping every frame of an
// animation. maxHeight is a hint: when the caller is about to scale the image
// down anyway, animations decoded through ffmpeg are shrunk during decoding
// instead of afterwards. Pass 0 for full size.
func loadImage(buf []byte, contentType string, maxHeight int) (*vips.ImageRef, error) {
	if looksLikeVideo(buf, contentType) {
		frameBuf, err := extractVideoFrame(buf)
		if err == nil && len(frameBuf) > 0 {
			buf = frameBuf
		} else {
			log.Printf("warning: failed to extract video frame: %v", err)
		}
		// A single extracted frame is never animated.
		return loadImageBuffer(buf)
	}

	img, err := loadImageBuffer(buf)
	if err == nil && img.Metadata().Pages > 1 {
		return img, nil // libvips already has every frame
	}

	// APNG and animated AVIF decode to a single frame in libvips: PNG loaders
	// ignore acTL/fcTL, and libheif only reads the still primary item. Fall
	// back to ffmpeg, which understands both.
	if !sniffAnimated(buf) {
		return img, err
	}
	anim, animErr := decodeAnimation(buf, maxHeight)
	if animErr == nil {
		if img != nil {
			img.Close()
		}
		return anim, nil
	}
	log.Printf("warning: animated decode failed, falling back to a still frame: %v", animErr)
	return img, err
}

func loadImageBuffer(buf []byte) (*vips.ImageRef, error) {
	params := vips.NewImportParams()
	params.NumPages.Set(-1)
	return vips.LoadImageFromBuffer(buf, params)
}

func sendWebP(w http.ResponseWriter, img *vips.ImageRef) {
	data, err := exportToWebP(img)
	if err != nil {
		http.Error(w, fmt.Sprintf("Export error: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "image/webp")
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.Write(data)
}

func exportToWebP(img *vips.ImageRef) ([]byte, error) {
	if err := prepareForExport(img); err != nil {
		return nil, err
	}

	p := vips.NewWebpExportParams()
	p.Quality = webpQuality
	p.ReductionEffort = webpEffort
	p.StripMetadata = true

	data, _, err := img.ExportWebp(p)
	return data, err
}

// prepareForExport makes an image safe to save without its metadata.
//
// Dropping metadata is only harmless once the two tags that change how an image
// is displayed have been resolved into the pixels themselves: EXIF orientation
// (otherwise a phone photo comes out on its side) and the colour profile
// (otherwise a wide-gamut or CMYK source is reinterpreted as sRGB and the
// colours shift). Both are applied here, then everything descriptive goes.
func prepareForExport(img *vips.ImageRef) error {
	// Rotating an animation would spin the whole filmstrip rather than each
	// frame, and animated formats do not carry orientation in practice.
	if img.Metadata().Pages <= 1 {
		if err := img.AutoRotate(); err != nil {
			return fmt.Errorf("autorotate: %w", err)
		}
	}
	// Converts the pixels into sRGB and tags them with a ~500 byte standard
	// profile; a no-op for images that are already untagged sRGB.
	if err := img.OptimizeICCProfile(); err != nil {
		log.Printf("warning: could not normalise the colour profile: %v", err)
	}
	// Drops EXIF, XMP, IPTC and friends. Colour profile, orientation and the
	// animation fields (pages, page height, delay, loop) are kept by govips
	// because the encoder still needs them.
	if err := img.RemoveMetadata(); err != nil {
		return fmt.Errorf("remove metadata: %w", err)
	}
	return nil
}

// scaleToHeight shrinks an image so each frame is at most targetHeight tall.
// For an animation libvips holds every frame in one tall image, so the page
// height has to be restated afterwards - and it has to match what the resize
// actually produced, or the encoder slices the frames in the wrong places.
func scaleToHeight(img *vips.ImageRef, targetHeight int) error {
	pages := img.Metadata().Pages
	if pages < 1 {
		pages = 1
	}
	if img.PageHeight() <= targetHeight {
		return nil
	}

	scale := float64(targetHeight) / float64(img.PageHeight())
	if pages > 1 {
		// Scale the strip as a whole so its height stays an exact multiple of
		// the frame count.
		scale = float64(targetHeight*pages) / float64(img.Height())
	}
	if err := img.Resize(scale, vips.KernelLanczos3); err != nil {
		return err
	}
	if pages > 1 {
		pageHeight := img.Height() / pages
		if pageHeight < 1 {
			return fmt.Errorf("resized height %d is too small for %d frames", img.Height(), pages)
		}
		// Rounding can leave the strip a row or two short of an exact multiple
		// of the frame count; trim rather than let the encoder cut the frames
		// in the wrong places.
		if pageHeight*pages != img.Height() {
			if err := img.ExtractArea(0, 0, img.Width(), pageHeight*pages); err != nil {
				return fmt.Errorf("trim filmstrip: %w", err)
			}
		}
		if err := img.SetPageHeight(pageHeight); err != nil {
			return fmt.Errorf("set page height: %w", err)
		}
	}
	return nil
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

	img, err := loadImage(buf, "", targetHeight)
	if err != nil {
		return nil, err
	}
	defer img.Close()

	if targetHeight > 0 {
		if err := scaleToHeight(img, targetHeight); err != nil {
			return nil, err
		}
	}

	return exportToWebP(img)
}

func copyZipEntry(zw *zip.Writer, file *zip.File, name string) {
	rc, err := file.Open()
	if err != nil {
		log.Printf("bulk: failed to open entry %s: %v", name, err)
		return
	}
	defer rc.Close()
	out, err := zw.Create(name)
	if err != nil {
		log.Printf("bulk: failed to create zip entry %s: %v", name, err)
		return
	}
	io.Copy(out, rc)
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
        <button onclick="process('strip')" class="secondary">Strip Metadata</button>
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
                } else if (action === 'strip') {
                    a.download = "stripped_" + selectedFile.name;
                } else {
                    a.download = newName + ".webp";
                }

                document.body.appendChild(a);
                a.click();
                a.remove();
                window.URL.revokeObjectURL(downloadUrl);
                status.innerText = "Download started!";

                if (action === 'strip') {
                    const removed = response.headers.get('X-Strip-Removed');
                    const changed = response.headers.get('X-Strip-Changed') === 'true';
                    output.innerHTML = '<pre>' + JSON.stringify({
                        format: response.headers.get('X-Strip-Format'),
                        changed: changed,
                        verified: response.headers.get('X-Strip-Verified') === 'true',
                        removed: removed ? removed.split(',') : [],
                        note: response.headers.get('X-Strip-Note') || '',
                        bytes: selectedFile.size + ' -> ' + blob.size
                    }, null, 2) + '</pre>';
                }

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
