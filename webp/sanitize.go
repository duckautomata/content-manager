package main

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"hash/crc32"
	"sort"
	"strings"

	"github.com/davidbyttow/govips/v2/vips"
)

// Metadata stripping, the careful way.
//
// The obvious implementation - decode the image and encode it again without
// metadata - re-compresses pixels that were already compressed, so originals
// would lose quality every time they are touched. The other obvious
// implementation - find the metadata bytes and delete them - is what corrupted
// years of animated WebP uploads at Discord: their EXIF remover deleted the
// EXIF chunk but left the container's own bookkeeping (the VP8X feature flags
// and the RIFF length) describing a file that no longer existed, and the
// results were unplayable.
//
// So each format here is edited at the container level, updating whatever
// bookkeeping that container keeps, and never touching compressed pixel data.
// Chunks that decide how an image is *rendered* stay: colour profiles, palettes,
// transparency, gamma, animation control. Only descriptive metadata goes -
// EXIF, XMP, IPTC, Photoshop resources, comments, text records, timestamps.
//
// EXIF orientation is the one descriptive tag that changes rendering, so it is
// rebuilt into a minimal EXIF block instead of being dropped (see minimalExif).
//
// Every result is then verified against the input - same pixels, same geometry,
// same frames, same orientation, same colour profile - and a file that fails
// verification is returned unchanged rather than stored corrupted.

// stripReport describes what a strip pass did to one file.
type stripReport struct {
	Format        string   `json:"format"`
	Changed       bool     `json:"changed"`
	Removed       []string `json:"removed"`
	OriginalBytes int      `json:"original_bytes"`
	Bytes         int      `json:"bytes"`
	Verified      bool     `json:"verified"`
	Note          string   `json:"note,omitempty"`
}

// stripMetadata removes descriptive metadata from an encoded image without
// re-encoding it. The returned bytes are always safe to store: if anything at
// all looks wrong, the input is returned untouched with the reason in Note.
func stripMetadata(buf []byte) ([]byte, *stripReport, error) {
	out, report := stripWithoutVerifying(buf)
	if !report.Changed {
		return buf, report, nil
	}

	if err := verifyStrip(buf, out); err != nil {
		report.Changed = false
		report.Removed = nil
		report.Bytes = len(buf)
		report.Note = "left unchanged, verification failed: " + err.Error()
		return buf, report, nil
	}

	report.Verified = true
	return out, report, nil
}

// detectMetadata lists what a strip would remove, without doing the work of
// verifying the result. /info uses it to describe a file cheaply.
func detectMetadata(buf []byte) []string {
	_, report := stripWithoutVerifying(buf)
	return report.Removed
}

// stripWithoutVerifying runs the format-specific editor and reports what it
// did. The result is not safe to store until verifyStrip has passed.
func stripWithoutVerifying(buf []byte) ([]byte, *stripReport) {
	format := sniffFormat(buf)
	report := &stripReport{Format: format, OriginalBytes: len(buf), Bytes: len(buf)}

	var out []byte
	var removed []string
	var err error

	switch format {
	case "jpeg":
		out, removed, err = stripJPEG(buf)
	case "png":
		out, removed, err = stripPNG(buf)
	case "webp":
		out, removed, err = stripWebP(buf)
	case "gif":
		out, removed, err = stripGIF(buf)
	case "isobmff":
		out, removed, err = stripISOBMFF(buf)
	case "tiff":
		out, removed, err = stripTIFF(buf)
	case "bmp":
		report.Note = "format carries no metadata"
		return buf, report
	default:
		report.Note = "unsupported format; left unchanged"
		return buf, report
	}

	if err != nil {
		report.Note = "left unchanged: " + err.Error()
		return buf, report
	}

	sort.Strings(removed)
	if len(removed) == 0 || bytes.Equal(out, buf) {
		report.Note = "no metadata found"
		return buf, report
	}

	report.Changed = true
	report.Removed = removed
	report.Bytes = len(out)
	return out, report
}

func sniffFormat(buf []byte) string {
	switch {
	case len(buf) >= 3 && buf[0] == 0xFF && buf[1] == 0xD8 && buf[2] == 0xFF:
		return "jpeg"
	case bytes.HasPrefix(buf, pngSignature):
		return "png"
	case len(buf) >= 12 && string(buf[0:4]) == "RIFF" && string(buf[8:12]) == "WEBP":
		return "webp"
	case bytes.HasPrefix(buf, []byte("GIF87a")), bytes.HasPrefix(buf, []byte("GIF89a")):
		return "gif"
	case len(buf) >= 12 && string(buf[4:8]) == "ftyp":
		return "isobmff"
	case bytes.HasPrefix(buf, []byte{'I', 'I', 42, 0}), bytes.HasPrefix(buf, []byte{'M', 'M', 0, 42}):
		return "tiff"
	case bytes.HasPrefix(buf, []byte("BM")):
		return "bmp"
	}
	return "unknown"
}

// verifyStrip re-decodes both versions and refuses any difference a viewer
// could see. This is the backstop that keeps a bug in one of the container
// editors below from ever producing a stored file that is worse than the one it
// replaced.
func verifyStrip(original, stripped []byte) error {
	params := vips.NewImportParams()
	params.NumPages.Set(-1)

	before, err := vips.LoadImageFromBuffer(original, params)
	if err != nil {
		// We could not read the input either, so we cannot judge the output.
		// Refuse to swap the bytes.
		return fmt.Errorf("original does not decode: %w", err)
	}
	defer before.Close()

	after, err := vips.LoadImageFromBuffer(stripped, params)
	if err != nil {
		return fmt.Errorf("result does not decode: %w", err)
	}
	defer after.Close()

	if before.Width() != after.Width() || before.Height() != after.Height() {
		return fmt.Errorf("size changed from %dx%d to %dx%d",
			before.Width(), before.Height(), after.Width(), after.Height())
	}
	if before.Metadata().Pages != after.Metadata().Pages {
		return fmt.Errorf("frame count changed from %d to %d",
			before.Metadata().Pages, after.Metadata().Pages)
	}
	if before.PageHeight() != after.PageHeight() {
		return fmt.Errorf("frame height changed from %d to %d", before.PageHeight(), after.PageHeight())
	}
	if before.Bands() != after.Bands() {
		return fmt.Errorf("band count changed from %d to %d", before.Bands(), after.Bands())
	}
	if before.Orientation() != after.Orientation() {
		return fmt.Errorf("orientation changed from %d to %d", before.Orientation(), after.Orientation())
	}
	if before.HasICCProfile() != after.HasICCProfile() {
		return fmt.Errorf("ICC profile presence changed from %t to %t",
			before.HasICCProfile(), after.HasICCProfile())
	}
	if before.HasAlpha() != after.HasAlpha() {
		return fmt.Errorf("alpha presence changed from %t to %t", before.HasAlpha(), after.HasAlpha())
	}

	// Pixel-exact comparison over every frame. libvips evaluates this lazily,
	// so even a long animation is streamed rather than held in memory twice.
	diff, err := before.Copy()
	if err != nil {
		return fmt.Errorf("copy for comparison: %w", err)
	}
	defer diff.Close()
	if err := diff.Subtract(after); err != nil {
		return fmt.Errorf("compare: %w", err)
	}
	if err := diff.Abs(); err != nil {
		return fmt.Errorf("compare: %w", err)
	}
	mean, err := diff.Average()
	if err != nil {
		return fmt.Errorf("compare: %w", err)
	}
	if mean != 0 {
		return fmt.Errorf("pixels changed (mean absolute difference %g)", mean)
	}

	// The comparison above only covers what libvips can decode, which for an
	// APNG or an animated AVIF is the first frame alone. Count the rest.
	if sniffAnimated(original) {
		beforeFrames, beforeErr := countAnimationFrames(original)
		afterFrames, afterErr := countAnimationFrames(stripped)
		if beforeErr == nil {
			if afterErr != nil {
				return fmt.Errorf("frames no longer readable: %w", afterErr)
			}
			if beforeFrames != afterFrames {
				return fmt.Errorf("frame count changed from %d to %d", beforeFrames, afterFrames)
			}
		}
	}
	return nil
}

// ---------------- EXIF helpers ----------------

// exifHeader is the APP1 marker prefix that introduces an EXIF TIFF block.
var exifHeader = []byte("Exif\x00\x00")

const tagOrientation = 0x0112

// tiffByteOrder returns the byte order of a TIFF header and the offset of the
// first IFD.
func tiffByteOrder(tiff []byte) (binary.ByteOrder, uint32, bool) {
	if len(tiff) < 8 {
		return nil, 0, false
	}
	var order binary.ByteOrder
	switch {
	case tiff[0] == 'I' && tiff[1] == 'I':
		order = binary.LittleEndian
	case tiff[0] == 'M' && tiff[1] == 'M':
		order = binary.BigEndian
	default:
		return nil, 0, false
	}
	if order.Uint16(tiff[2:4]) != 42 {
		return nil, 0, false
	}
	return order, order.Uint32(tiff[4:8]), true
}

// readOrientation returns the EXIF orientation stored in a TIFF block, or 0 if
// there is none. Orientation is the only EXIF tag that changes how an image is
// displayed, so it is the only one worth carrying over.
func readOrientation(tiff []byte) int {
	order, ifdOffset, ok := tiffByteOrder(tiff)
	if !ok || int(ifdOffset)+2 > len(tiff) {
		return 0
	}
	count := int(order.Uint16(tiff[ifdOffset : ifdOffset+2]))
	for i := 0; i < count; i++ {
		entry := int(ifdOffset) + 2 + i*12
		if entry+12 > len(tiff) {
			return 0
		}
		if order.Uint16(tiff[entry:entry+2]) != tagOrientation {
			continue
		}
		// SHORT value, stored inline in the first two bytes of the value field.
		return int(order.Uint16(tiff[entry+8 : entry+10]))
	}
	return 0
}

// minimalExif builds the smallest valid EXIF TIFF block that preserves the
// orientation of the block passed in. It returns nil when there is nothing
// worth keeping, which is the common case.
func minimalExif(tiff []byte) []byte {
	orientation := readOrientation(tiff)
	if orientation <= 1 || orientation > 8 {
		return nil
	}
	out := make([]byte, 0, 26)
	out = append(out, 'I', 'I', 42, 0) // little-endian TIFF
	out = binary.LittleEndian.AppendUint32(out, 8)
	out = binary.LittleEndian.AppendUint16(out, 1) // one entry
	out = binary.LittleEndian.AppendUint16(out, tagOrientation)
	out = binary.LittleEndian.AppendUint16(out, 3) // SHORT
	out = binary.LittleEndian.AppendUint32(out, 1) // one value
	out = binary.LittleEndian.AppendUint16(out, uint16(orientation))
	out = append(out, 0, 0)                        // padding of the 4-byte value field
	out = binary.LittleEndian.AppendUint32(out, 0) // no next IFD
	return out
}

// ---------------- JPEG ----------------

// stripJPEG rebuilds a JPEG from its marker segments, dropping the metadata
// ones. Entropy-coded scan data is copied byte for byte, so the image is
// bit-identical after decoding.
func stripJPEG(buf []byte) ([]byte, []string, error) {
	if len(buf) < 4 || buf[0] != 0xFF || buf[1] != 0xD8 {
		return nil, nil, fmt.Errorf("not a JPEG")
	}

	out := make([]byte, 0, len(buf))
	out = append(out, 0xFF, 0xD8)
	var removed []string

	i := 2
	for i+1 < len(buf) {
		if buf[i] != 0xFF {
			return nil, nil, fmt.Errorf("expected a marker at offset %d", i)
		}
		// Any number of 0xFF fill bytes may precede a marker.
		j := i
		for j < len(buf) && buf[j] == 0xFF {
			j++
		}
		if j >= len(buf) {
			return nil, nil, fmt.Errorf("truncated marker at offset %d", i)
		}
		marker := buf[j]

		if marker == 0xD9 { // EOI
			out = append(out, 0xFF, 0xD9)
			if j+1 < len(buf) {
				removed = append(removed, "trailing-data")
			}
			return out, removed, nil
		}
		if marker == 0x01 || (marker >= 0xD0 && marker <= 0xD7) { // standalone markers
			out = append(out, 0xFF, marker)
			i = j + 1
			continue
		}

		if j+3 > len(buf) {
			return nil, nil, fmt.Errorf("truncated segment at offset %d", j)
		}
		segLen := int(binary.BigEndian.Uint16(buf[j+1 : j+3]))
		if segLen < 2 || j+1+segLen > len(buf) {
			return nil, nil, fmt.Errorf("bad segment length %d at offset %d", segLen, j)
		}
		payload := buf[j+3 : j+1+segLen]

		if replacement, label, drop := jpegMetadataSegment(marker, payload); drop {
			removed = append(removed, label)
			if replacement != nil {
				out = append(out, 0xFF, marker)
				out = binary.BigEndian.AppendUint16(out, uint16(len(replacement)+2))
				out = append(out, replacement...)
			}
		} else {
			out = append(out, buf[j-1:j+1+segLen]...)
		}
		i = j + 1 + segLen

		if marker == 0xDA { // start of scan: entropy-coded data follows
			end := endOfScan(buf, i)
			out = append(out, buf[i:end]...)
			i = end
		}
	}

	// No EOI found: keep whatever is left so the file is no more truncated than
	// it already was.
	if i < len(buf) {
		out = append(out, buf[i:]...)
	}
	return out, removed, nil
}

// endOfScan walks entropy-coded data from start and returns the offset of the
// next real marker. Inside a scan an 0xFF byte is either a stuffed 0xFF00, a
// restart marker, or fill before the marker that ends the scan.
func endOfScan(buf []byte, start int) int {
	for k := start; k+1 < len(buf); {
		if buf[k] != 0xFF {
			k++
			continue
		}
		switch next := buf[k+1]; {
		case next == 0xFF: // fill byte; the marker may be the byte after it
			k++
		case next == 0x00 || (next >= 0xD0 && next <= 0xD7): // stuffed byte or restart marker
			k += 2
		default:
			return k
		}
	}
	return len(buf)
}

// jpegMetadataSegment decides the fate of one APPn/COM segment. When drop is
// true and replacement is non-nil, the segment is rewritten with that payload
// instead of being deleted.
func jpegMetadataSegment(marker byte, payload []byte) (replacement []byte, label string, drop bool) {
	hasPrefix := func(s string) bool { return bytes.HasPrefix(payload, []byte(s)) }

	switch marker {
	case 0xFE: // COM
		return nil, "jpeg:comment", true
	case 0xE0: // APP0
		if hasPrefix("JFXX\x00") { // embedded thumbnail
			return nil, "jpeg:jfxx-thumbnail", true
		}
		return nil, "", false // JFIF density: rendering information, keep
	case 0xE1: // APP1
		if bytes.HasPrefix(payload, exifHeader) {
			// Rebuild with orientation only; everything else (camera, GPS,
			// timestamps, the embedded thumbnail) goes.
			if minimal := minimalExif(payload[len(exifHeader):]); minimal != nil {
				return append(append([]byte{}, exifHeader...), minimal...), "jpeg:exif", true
			}
			return nil, "jpeg:exif", true
		}
		if hasPrefix("http://ns.adobe.com/xap/1.0/") || hasPrefix("http://ns.adobe.com/xmp/extension/") {
			return nil, "jpeg:xmp", true
		}
		return nil, "jpeg:app1", true
	case 0xE2: // APP2
		if hasPrefix("ICC_PROFILE\x00") {
			return nil, "", false // colour profile: keep
		}
		if hasPrefix("MPF\x00") {
			return nil, "jpeg:mpf", true // index of appended images, which we also drop
		}
		return nil, "jpeg:app2", true
	case 0xED: // APP13, Photoshop image resources (IPTC lives here)
		return nil, "jpeg:photoshop-iptc", true
	case 0xEE: // APP14
		if hasPrefix("Adobe") {
			return nil, "", false // colour transform flag: dropping it breaks CMYK
		}
		return nil, "jpeg:app14", true
	}
	if marker >= 0xE3 && marker <= 0xEF { // remaining application segments
		return nil, fmt.Sprintf("jpeg:app%d", marker-0xE0), true
	}
	return nil, "", false
}

// ---------------- PNG (including APNG) ----------------

type pngChunk struct {
	offset int // offset of the length field
	total  int // length + type + data + CRC
	typ    string
	data   []byte
}

func iterPNGChunks(buf []byte) []pngChunk {
	var chunks []pngChunk
	if !bytes.HasPrefix(buf, pngSignature) {
		return chunks
	}
	for i := len(pngSignature); i+8 <= len(buf); {
		length := int(binary.BigEndian.Uint32(buf[i : i+4]))
		if length < 0 || i+12+length > len(buf) {
			break
		}
		typ := string(buf[i+4 : i+8])
		chunks = append(chunks, pngChunk{
			offset: i,
			total:  length + 12,
			typ:    typ,
			data:   buf[i+8 : i+8+length],
		})
		i += length + 12
		if typ == "IEND" {
			break
		}
	}
	return chunks
}

// pngRenderingChunks are the chunks that decide what the image looks like:
// everything else in a PNG is descriptive and can go.
var pngRenderingChunks = map[string]bool{
	"IHDR": true, "PLTE": true, "IDAT": true, "IEND": true,
	"tRNS": true, "gAMA": true, "cHRM": true, "sRGB": true, "iCCP": true,
	"sBIT": true, "bKGD": true, "hIST": true, "pHYs": true, "sPLT": true,
	"cICP": true, "mDCv": true, "cLLi": true, // HDR colour signalling
	"acTL": true, "fcTL": true, "fdAT": true, // APNG animation control
}

func stripPNG(buf []byte) ([]byte, []string, error) {
	chunks := iterPNGChunks(buf)
	if len(chunks) == 0 || chunks[0].typ != "IHDR" {
		return nil, nil, fmt.Errorf("not a PNG")
	}

	out := make([]byte, 0, len(buf))
	out = append(out, pngSignature...)
	var removed []string
	sawIEND := false

	for _, c := range chunks {
		if pngRenderingChunks[c.typ] {
			out = append(out, buf[c.offset:c.offset+c.total]...)
			if c.typ == "IEND" {
				sawIEND = true
			}
			continue
		}
		if c.typ == "eXIf" {
			// Same rule as JPEG: keep orientation, drop the rest.
			if minimal := minimalExif(c.data); minimal != nil {
				out = append(out, buildPNGChunk("eXIf", minimal)...)
			}
			removed = append(removed, "png:eXIf")
			continue
		}
		removed = append(removed, "png:"+c.typ)
	}

	if !sawIEND {
		return nil, nil, fmt.Errorf("no IEND chunk")
	}
	// Anything after IEND is not part of the image.
	if end := chunks[len(chunks)-1]; end.typ == "IEND" && end.offset+end.total < len(buf) {
		removed = append(removed, "png:trailing-data")
	}
	return out, removed, nil
}

func buildPNGChunk(typ string, data []byte) []byte {
	out := make([]byte, 0, len(data)+12)
	out = binary.BigEndian.AppendUint32(out, uint32(len(data)))
	out = append(out, typ...)
	out = append(out, data...)
	return binary.BigEndian.AppendUint32(out, crc32PNG(append([]byte(typ), data...)))
}

// crc32PNG is the standard IEEE CRC-32 that PNG appends to every chunk.
func crc32PNG(b []byte) uint32 {
	return crc32.ChecksumIEEE(b)
}

func joinLabels(labels []string) string {
	if len(labels) == 0 {
		return ""
	}
	return strings.Join(labels, ",")
}
