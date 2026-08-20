package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"strconv"
	"strings"

	"github.com/davidbyttow/govips/v2/vips"
)

// libvips cannot decode every animation we accept: PNG is decoded by
// libspng/libpng, which ignore APNG's acTL/fcTL frames, and libheif only reads
// the still primary item of an AVIF, never its animation track. Both formats
// therefore arrive as a single frame and the preview/thumbnail come out static.
//
// ffmpeg understands both. We ask it for every frame stacked into one tall
// "filmstrip" PNG, which is exactly how libvips represents an animation
// internally (one tall image plus a page-height), so the rest of the pipeline
// (resize, WebP export) needs no special cases.

const (
	// A filmstrip is decoded into memory as RGBA, so cap what we are willing to
	// build. Both limits are per-request; sources beyond them keep as many
	// leading frames as fit.
	defaultMaxAnimationFrames = 300
	defaultMaxFilmstripPixels = 50_000_000
)

var (
	maxAnimationFrames = defaultMaxAnimationFrames // override via MAX_ANIM_FRAMES
	maxFilmstripPixels = defaultMaxFilmstripPixels // override via MAX_ANIM_PIXELS
)

// sniffAnimated reports whether buf is an animation that libvips decodes as a
// single frame. It is only consulted after libvips has already reported one
// page, so formats libvips animates natively (GIF, WebP) are not listed here.
func sniffAnimated(buf []byte) bool {
	return isAPNG(buf) || isAnimatedISOBMFF(buf)
}

var pngSignature = []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A}

// isAPNG reports whether buf is a PNG carrying an acTL chunk before the first
// IDAT, which is what makes it an animated PNG.
func isAPNG(buf []byte) bool {
	_, animated := parsePNGAnimation(buf)
	return animated
}

// parsePNGAnimation returns the APNG loop count (0 = forever) and whether buf is
// an APNG at all.
func parsePNGAnimation(buf []byte) (loop int, animated bool) {
	if !bytes.HasPrefix(buf, pngSignature) {
		return 0, false
	}
	for _, c := range iterPNGChunks(buf) {
		switch c.typ {
		case "acTL":
			// acTL is num_frames (4 bytes) then num_plays (4 bytes).
			if len(c.data) >= 8 {
				return int(binary.BigEndian.Uint32(c.data[4:8])), true
			}
			return 0, true
		case "IDAT":
			// acTL must precede IDAT; anything later is not a valid animation.
			return 0, false
		}
	}
	return 0, false
}

// isAnimatedISOBMFF reports whether buf is an ISO-BMFF file (AVIF/HEIF) that
// carries an image sequence. Animated AVIFs declare the "avis" brand and store
// their frames in a movie track, unlike still AVIFs which only have a `meta`
// box.
func isAnimatedISOBMFF(buf []byte) bool {
	brands, ok := isobmffBrands(buf)
	if !ok {
		return false
	}
	for _, b := range brands {
		switch b {
		case "avis", "msf1", "mif2": // AVIF sequence / HEIF sequence brands
			return true
		}
	}
	// Some encoders omit the sequence brand; a top-level moov box is the
	// authoritative sign that there are tracks to play.
	for _, b := range iterISOBMFFBoxes(buf, 0, len(buf)) {
		if b.typ == "moov" {
			return true
		}
	}
	return false
}

// isoImageBrands are the ISO-BMFF brands that mean "this is a picture", not a
// movie: still images, image sequences and the AVIF/HEIF profiles.
var isoImageBrands = map[string]bool{
	"avif": true, "avis": true, "avio": true,
	"heic": true, "heix": true, "heim": true, "heis": true,
	"hevc": true, "hevx": true, "hevm": true, "hevs": true,
	"mif1": true, "mif2": true, "msf1": true, "miaf": true, "MA1A": true, "MA1B": true,
}

// isISOBMFFImage reports whether an ISO base media file is an image rather than
// a video.
func isISOBMFFImage(buf []byte) bool {
	brands, ok := isobmffBrands(buf)
	if !ok {
		return false
	}
	for _, b := range brands {
		if isoImageBrands[b] {
			return true
		}
	}
	return false
}

func isobmffBrands(buf []byte) ([]string, bool) {
	if len(buf) < 16 || string(buf[4:8]) != "ftyp" {
		return nil, false
	}
	size := int(binary.BigEndian.Uint32(buf[0:4]))
	if size < 16 || size > len(buf) {
		size = len(buf)
	}
	brands := []string{string(buf[8:12])}
	for i := 16; i+4 <= size; i += 4 {
		brands = append(brands, string(buf[i:i+4]))
	}
	return brands, true
}

// animationSource is one decoded animation, ready to be handed to libvips.
type animationSource struct {
	filmstrip []byte // tall PNG: every frame stacked top to bottom
	frames    int
	delaysMs  []int
	loop      int // 0 = repeat forever
}

// decodeAnimation runs the ffmpeg fallback and returns a libvips image whose
// page metadata describes the animation. maxHeight, when > 0, asks ffmpeg to
// scale frames down during extraction so we never materialise a filmstrip far
// larger than the caller needs.
func decodeAnimation(buf []byte, maxHeight int) (*vips.ImageRef, error) {
	src, err := extractAnimation(buf, maxHeight)
	if err != nil {
		return nil, err
	}

	params := vips.NewImportParams()
	params.NumPages.Set(-1)
	img, err := vips.LoadImageFromBuffer(src.filmstrip, params)
	if err != nil {
		return nil, fmt.Errorf("load filmstrip: %w", err)
	}

	pageHeight := img.Height() / src.frames
	if pageHeight < 1 || pageHeight*src.frames != img.Height() {
		img.Close()
		return nil, fmt.Errorf("filmstrip height %d is not divisible by %d frames", img.Height(), src.frames)
	}
	if err := img.SetPageHeight(pageHeight); err != nil {
		img.Close()
		return nil, fmt.Errorf("set page height: %w", err)
	}
	if err := img.SetPages(src.frames); err != nil {
		img.Close()
		return nil, fmt.Errorf("set pages: %w", err)
	}
	if err := img.SetPageDelay(src.delaysMs); err != nil {
		img.Close()
		return nil, fmt.Errorf("set page delay: %w", err)
	}
	if err := img.SetLoop(src.loop); err != nil {
		log.Printf("warning: failed to set loop count: %v", err)
	}
	return img, nil
}

func extractAnimation(buf []byte, maxHeight int) (*animationSource, error) {
	// ffprobe needs to seek (ISO-BMFF keeps its index in a box that may sit
	// after the media data), so the input goes through a temp file.
	tmp, err := os.CreateTemp("", "anim-*")
	if err != nil {
		return nil, err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	if _, err := tmp.Write(buf); err != nil {
		return nil, err
	}
	if err := tmp.Close(); err != nil {
		return nil, err
	}

	probed, err := probeAnimation(tmp.Name())
	if err != nil {
		return nil, err
	}
	if len(probed.delaysMs) < 2 {
		return nil, fmt.Errorf("source has %d frames, not an animation", len(probed.delaysMs))
	}

	height := probed.height
	if maxHeight > 0 && height > maxHeight {
		height = maxHeight
	}
	frames := capFrames(len(probed.delaysMs), probed.width, height)
	delays := probed.delaysMs[:frames]

	filmstrip, err := buildFilmstrip(tmp.Name(), probed.index, frames, maxHeight)
	if err != nil {
		return nil, err
	}

	loop, _ := parsePNGAnimation(buf) // 0 for every other format: repeat forever
	return &animationSource{filmstrip: filmstrip, frames: frames, delaysMs: delays, loop: loop}, nil
}

type ffprobeOutput struct {
	Streams []struct {
		Index     int    `json:"index"`
		CodecType string `json:"codec_type"`
		Width     int    `json:"width"`
		Height    int    `json:"height"`
	} `json:"streams"`
	Packets []struct {
		StreamIndex  int    `json:"stream_index"`
		PTSTime      string `json:"pts_time"`
		DurationTime string `json:"duration_time"`
	} `json:"packets"`
}

// probedAnimation describes the stream ffmpeg will decode frames from.
type probedAnimation struct {
	index         int
	width, height int
	delaysMs      []int
}

// probeAnimation picks the video stream holding the animation and returns its
// per-frame delays in milliseconds. Animated AVIFs expose both the still
// primary item and the animation track as video streams (ffmpeg >= 6), so the
// stream with the most packets is the one we want.
func probeAnimation(path string) (*probedAnimation, error) {
	ctx, cancel := context.WithTimeout(context.Background(), ffmpegTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "ffprobe", "-v", "error",
		"-select_streams", "v",
		"-show_entries", "stream=index,codec_type,width,height:packet=stream_index,pts_time,duration_time",
		"-of", "json", path)
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("ffprobe: %w", err)
	}

	var probe ffprobeOutput
	if err := json.Unmarshal(out, &probe); err != nil {
		return nil, fmt.Errorf("ffprobe output: %w", err)
	}

	// Group packet timings by stream, preserving order.
	type timing struct{ pts, dur float64 }
	byStream := map[int][]timing{}
	for _, p := range probe.Packets {
		pts, errPTS := strconv.ParseFloat(p.PTSTime, 64)
		if errPTS != nil {
			pts = -1
		}
		dur, errDur := strconv.ParseFloat(p.DurationTime, 64)
		if errDur != nil {
			dur = 0
		}
		byStream[p.StreamIndex] = append(byStream[p.StreamIndex], timing{pts: pts, dur: dur})
	}

	best, bestCount := -1, 0
	result := &probedAnimation{}
	for _, s := range probe.Streams {
		if s.CodecType != "video" {
			continue
		}
		if n := len(byStream[s.Index]); n > bestCount {
			best, bestCount = s.Index, n
			result.index, result.width, result.height = s.Index, s.Width, s.Height
		}
	}
	if best < 0 {
		return nil, fmt.Errorf("no video stream found")
	}

	times := byStream[best]
	delays := make([]int, len(times))
	for i, t := range times {
		d := t.dur
		// Packet durations are the reliable source for APNG (each fcTL carries
		// its own delay); fall back to the gap to the next presentation stamp.
		if d <= 0 && i+1 < len(times) && times[i+1].pts >= 0 && t.pts >= 0 {
			d = times[i+1].pts - t.pts
		}
		ms := int(d*1000 + 0.5)
		if ms <= 0 {
			ms = 100 // browsers clamp 0-delay frames anyway; 10fps is the common default
		}
		delays[i] = ms
	}
	// A trailing frame with no duration inherits the previous one.
	if n := len(delays); n > 1 && times[n-1].dur <= 0 {
		delays[n-1] = delays[n-2]
	}
	result.delaysMs = delays
	return result, nil
}

// buildFilmstrip decodes `frames` frames of the given stream and stacks them
// into a single tall PNG.
func buildFilmstrip(path string, stream, frames, maxHeight int) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), ffmpegTimeout)
	defer cancel()

	// format=rgba keeps any alpha channel; tile stacks the frames with no gaps.
	filters := []string{"format=rgba"}
	if maxHeight > 0 {
		// -1 keeps the aspect ratio; min() leaves smaller sources untouched.
		filters = append(filters, fmt.Sprintf("scale=-1:'min(ih,%d)':flags=lanczos", maxHeight))
	}
	filters = append(filters, fmt.Sprintf("tile=1x%d:padding=0:margin=0", frames))

	args := []string{"-v", "error", "-i", path,
		"-map", fmt.Sprintf("0:%d", stream),
		"-fps_mode", "passthrough",
		"-vf", strings.Join(filters, ","),
		"-frames:v", "1", // tile emits exactly one image: the whole filmstrip
		"-c:v", "png", "-f", "image2", "-"}

	cmd := exec.CommandContext(ctx, "ffmpeg", args...)
	var out, stderr bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return nil, fmt.Errorf("ffmpeg timed out after %s", ffmpegTimeout)
		}
		return nil, fmt.Errorf("ffmpeg: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	if out.Len() == 0 {
		return nil, fmt.Errorf("ffmpeg produced no filmstrip")
	}
	return out.Bytes(), nil
}

// capFrames limits how many frames we stack, so neither a very long animation
// nor a very large one can exhaust memory. Frames past the cap are dropped.
func capFrames(frames, width, height int) int {
	capped := frames
	if capped > maxAnimationFrames {
		capped = maxAnimationFrames
	}
	if width > 0 && height > 0 {
		budget := maxFilmstripPixels / (width * height)
		if budget < 1 {
			budget = 1
		}
		if capped > budget {
			capped = budget
		}
	}
	if capped < frames {
		log.Printf("animation: keeping %d of %d frames (frame/pixel budget)", capped, frames)
	}
	return capped
}

// countAnimationFrames reports how many frames an animation libvips cannot
// decode actually has.
func countAnimationFrames(buf []byte) (int, error) {
	tmp, err := os.CreateTemp("", "probe-*")
	if err != nil {
		return 0, err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(buf); err != nil {
		tmp.Close()
		return 0, err
	}
	if err := tmp.Close(); err != nil {
		return 0, err
	}
	probed, err := probeAnimation(tmp.Name())
	if err != nil {
		return 0, err
	}
	return len(probed.delaysMs), nil
}
