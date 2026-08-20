package main

import (
	"bytes"
	"encoding/binary"
	"fmt"
)

// ---------------- WebP ----------------
//
// A WebP is a RIFF file. Metadata lives in EXIF and XMP chunks, but the VP8X
// header also carries feature flags saying which of those chunks exist, and the
// RIFF header carries the total payload length. Deleting a chunk without fixing
// both is what made Discord's stripped animated WebPs unplayable, so this does
// all three.

const (
	vp8xFlagICC   = 0x20
	vp8xFlagAlpha = 0x10
	vp8xFlagEXIF  = 0x08
	vp8xFlagXMP   = 0x04
	vp8xFlagAnim  = 0x02
)

type riffChunk struct {
	fourCC  string
	payload []byte
	total   int // header + payload + pad byte
}

func iterRIFFChunks(buf []byte) ([]riffChunk, error) {
	if len(buf) < 12 || string(buf[0:4]) != "RIFF" || string(buf[8:12]) != "WEBP" {
		return nil, fmt.Errorf("not a WebP")
	}
	end := 8 + int(binary.LittleEndian.Uint32(buf[4:8]))
	if end > len(buf) || end < 12 {
		end = len(buf)
	}

	var chunks []riffChunk
	for i := 12; i+8 <= end; {
		size := int(binary.LittleEndian.Uint32(buf[i+4 : i+8]))
		if size < 0 || i+8+size > end {
			return nil, fmt.Errorf("chunk %q runs past the end of the file", string(buf[i:i+4]))
		}
		total := 8 + size
		if size%2 == 1 { // chunks are padded to an even length
			total++
		}
		chunks = append(chunks, riffChunk{
			fourCC:  string(buf[i : i+4]),
			payload: buf[i+8 : i+8+size],
			total:   total,
		})
		i += total
	}
	return chunks, nil
}

func stripWebP(buf []byte) ([]byte, []string, error) {
	chunks, err := iterRIFFChunks(buf)
	if err != nil {
		return nil, nil, err
	}
	if len(chunks) == 0 {
		return nil, nil, fmt.Errorf("no chunks")
	}
	// A "simple format" WebP is just a bitstream chunk and cannot hold metadata.
	if chunks[0].fourCC == "VP8 " || chunks[0].fourCC == "VP8L" {
		return buf, nil, nil
	}
	if chunks[0].fourCC != "VP8X" {
		return nil, nil, fmt.Errorf("unexpected first chunk %q", chunks[0].fourCC)
	}
	if len(chunks[0].payload) < 10 {
		return nil, nil, fmt.Errorf("short VP8X chunk")
	}

	var removed []string
	var kept []riffChunk
	var exifOrientation []byte

	for _, c := range chunks {
		switch c.fourCC {
		case "EXIF":
			if minimal := minimalExif(c.payload); minimal != nil {
				exifOrientation = minimal
			}
			removed = append(removed, "webp:EXIF")
		case "XMP ":
			removed = append(removed, "webp:XMP")
		case "VP8X", "ICCP", "ANIM", "ANMF", "ALPH", "VP8 ", "VP8L":
			kept = append(kept, c)
		default:
			// Unknown chunks are skippable by spec and are the sort of place
			// stray metadata ends up.
			removed = append(removed, "webp:"+c.fourCC)
		}
	}
	if exifOrientation != nil {
		kept = append(kept, riffChunk{fourCC: "EXIF", payload: exifOrientation})
	}
	if len(removed) == 0 {
		return buf, nil, nil
	}

	// Rewrite the VP8X feature flags to match the chunks that survived.
	vp8x := append([]byte{}, kept[0].payload...)
	flags := vp8x[0]
	if exifOrientation == nil {
		flags &^= vp8xFlagEXIF
	}
	flags &^= vp8xFlagXMP
	vp8x[0] = flags
	kept[0].payload = vp8x

	body := make([]byte, 0, len(buf))
	for _, c := range kept {
		body = append(body, c.fourCC...)
		body = binary.LittleEndian.AppendUint32(body, uint32(len(c.payload)))
		body = append(body, c.payload...)
		if len(c.payload)%2 == 1 {
			body = append(body, 0)
		}
	}

	out := make([]byte, 0, len(body)+12)
	out = append(out, "RIFF"...)
	out = binary.LittleEndian.AppendUint32(out, uint32(len(body)+4)) // + "WEBP"
	out = append(out, "WEBP"...)
	out = append(out, body...)
	return out, removed, nil
}

// ---------------- GIF ----------------
//
// GIF metadata hides in comment blocks and application extensions. The
// NETSCAPE2.0 extension is not metadata - it is the loop count - so it stays,
// as does the colour-management extension.

var gifKeptApplications = map[string]bool{
	"NETSCAPE2.0": true, // loop count
	"ANIMEXTS1.0": true, // older loop count spelling
	"ICCRGBG1012": true, // embedded ICC profile
}

func stripGIF(buf []byte) ([]byte, []string, error) {
	if len(buf) < 13 || (!bytes.HasPrefix(buf, []byte("GIF87a")) && !bytes.HasPrefix(buf, []byte("GIF89a"))) {
		return nil, nil, fmt.Errorf("not a GIF")
	}

	i := 13 // header + logical screen descriptor
	if buf[10]&0x80 != 0 {
		i += 3 * (1 << ((buf[10] & 0x07) + 1)) // global colour table
	}
	if i > len(buf) {
		return nil, nil, fmt.Errorf("truncated global colour table")
	}

	out := make([]byte, 0, len(buf))
	out = append(out, buf[:i]...)
	var removed []string

	for i < len(buf) {
		switch buf[i] {
		case 0x3B: // trailer
			out = append(out, 0x3B)
			if i+1 < len(buf) {
				removed = append(removed, "gif:trailing-data")
			}
			return out, removed, nil

		case 0x21: // extension
			if i+2 > len(buf) {
				return nil, nil, fmt.Errorf("truncated extension")
			}
			label := buf[i+1]
			end, err := gifSkipSubBlocks(buf, i+2)
			if err != nil {
				return nil, nil, err
			}
			keep := false
			switch label {
			case 0xF9, 0x01: // graphic control, plain text
				keep = true
			case 0xFF: // application extension
				if i+3 <= len(buf) && int(buf[i+2]) == 11 && i+14 <= len(buf) {
					keep = gifKeptApplications[string(buf[i+3:i+14])]
				}
				if !keep {
					name := "unknown"
					if i+14 <= len(buf) {
						name = string(bytes.TrimRight(buf[i+3:i+14], "\x00 "))
					}
					removed = append(removed, "gif:application:"+name)
				}
			case 0xFE: // comment
				removed = append(removed, "gif:comment")
			default:
				removed = append(removed, fmt.Sprintf("gif:extension:0x%02X", label))
			}
			if keep {
				out = append(out, buf[i:end]...)
			}
			i = end

		case 0x2C: // image descriptor
			start := i
			i += 10
			if i > len(buf) {
				return nil, nil, fmt.Errorf("truncated image descriptor")
			}
			if buf[start+9]&0x80 != 0 {
				i += 3 * (1 << ((buf[start+9] & 0x07) + 1)) // local colour table
			}
			if i >= len(buf) {
				return nil, nil, fmt.Errorf("truncated local colour table")
			}
			i++ // LZW minimum code size
			end, err := gifSkipSubBlocks(buf, i)
			if err != nil {
				return nil, nil, err
			}
			out = append(out, buf[start:end]...)
			i = end

		default:
			return nil, nil, fmt.Errorf("unexpected block 0x%02X at offset %d", buf[i], i)
		}
	}
	return nil, nil, fmt.Errorf("no trailer")
}

// gifSkipSubBlocks returns the offset just past the length-prefixed sub-block
// chain starting at i, including its terminating zero byte.
func gifSkipSubBlocks(buf []byte, i int) (int, error) {
	for i < len(buf) {
		n := int(buf[i])
		if n == 0 {
			return i + 1, nil
		}
		i += n + 1
	}
	return 0, fmt.Errorf("truncated sub-block chain")
}
