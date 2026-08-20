package main

import (
	"encoding/binary"
	"fmt"
)

// ---------------- ISO base media files (AVIF, HEIC, HEIF) ----------------
//
// These files address their own payloads by absolute file offset (the `iloc`
// box says "item 3 lives at byte 1234"), so removing bytes would invalidate
// every offset after the cut. Instead the metadata is erased in place: EXIF and
// XMP payloads are overwritten with zeros, and metadata boxes are retyped to
// `free`, the box type every reader is required to ignore. The file keeps its
// exact length and structure, so nothing that pointed anywhere still points
// somewhere wrong.

type isoBox struct {
	typ        string
	start      int // offset of the size field
	headerSize int
	size       int // whole box, header included
}

func (b isoBox) payloadStart() int { return b.start + b.headerSize }
func (b isoBox) payloadEnd() int   { return b.start + b.size }

func iterISOBMFFBoxes(buf []byte, start, end int) []isoBox {
	var boxes []isoBox
	if end > len(buf) {
		end = len(buf)
	}
	for i := start; i+8 <= end; {
		size := int(binary.BigEndian.Uint32(buf[i : i+4]))
		typ := string(buf[i+4 : i+8])
		header := 8
		switch size {
		case 0:
			size = end - i // extends to the end of the file
		case 1:
			if i+16 > end {
				return boxes
			}
			size = int(binary.BigEndian.Uint64(buf[i+8 : i+16]))
			header = 16
		}
		if size < header || i+size > end {
			return boxes
		}
		boxes = append(boxes, isoBox{typ: typ, start: i, headerSize: header, size: size})
		i += size
	}
	return boxes
}

type isoItem struct {
	typ         string
	contentType string
	extents     [][2]int // absolute file offset, length
}

func stripISOBMFF(buf []byte) ([]byte, []string, error) {
	boxes := iterISOBMFFBoxes(buf, 0, len(buf))
	if len(boxes) == 0 || boxes[0].typ != "ftyp" {
		return nil, nil, fmt.Errorf("not an ISO base media file")
	}

	out := append([]byte{}, buf...)
	var removed []string

	for _, b := range boxes {
		switch b.typ {
		case "meta":
			// The top-level meta box is the item index: it must survive, but
			// the EXIF and XMP items it points at must not.
			labels, err := blankISOMetadataItems(out, b)
			if err != nil {
				return nil, nil, err
			}
			removed = append(removed, labels...)
		case "moov":
			removed = append(removed, retypeNestedMetadataBoxes(out, b.payloadStart(), b.payloadEnd(), 0)...)
		case "udta", "uuid":
			retypeBoxToFree(out, b)
			removed = append(removed, "iso:"+b.typ)
		}
	}
	return out, removed, nil
}

// retypeBoxToFree turns a box into a `free` box of identical size and wipes its
// contents, which is the only way to delete something from a file whose
// internal offsets are absolute.
func retypeBoxToFree(out []byte, b isoBox) {
	copy(out[b.start+4:b.start+8], "free")
	for i := b.payloadStart(); i < b.payloadEnd(); i++ {
		out[i] = 0
	}
}

// retypeNestedMetadataBoxes walks a container (moov, trak, ...) and neutralises
// the metadata boxes inside it. The `meta` box nested in a movie holds tags
// like title and encoder; unlike the top-level `meta` of an AVIF it carries
// nothing needed to decode the image.
func retypeNestedMetadataBoxes(out []byte, start, end, depth int) []string {
	if depth > 4 {
		return nil
	}
	var removed []string
	for _, b := range iterISOBMFFBoxes(out, start, end) {
		switch b.typ {
		case "udta", "meta", "uuid":
			retypeBoxToFree(out, b)
			removed = append(removed, "iso:moov/"+b.typ)
		case "trak", "mdia", "minf", "edts":
			removed = append(removed, retypeNestedMetadataBoxes(out, b.payloadStart(), b.payloadEnd(), depth+1)...)
		}
	}
	return removed
}

// blankISOMetadataItems finds the EXIF and XMP items described by a meta box
// and overwrites their payloads where they lie in the file.
func blankISOMetadataItems(out []byte, meta isoBox) ([]string, error) {
	// meta is a FullBox: four bytes of version and flags before its children.
	children := iterISOBMFFBoxes(out, meta.payloadStart()+4, meta.payloadEnd())

	items := map[uint32]*isoItem{}
	for _, c := range children {
		if c.typ == "iinf" {
			parseIINF(out, c, items)
		}
	}
	for _, c := range children {
		if c.typ == "iloc" {
			if err := parseILOC(out, c, items); err != nil {
				return nil, err
			}
		}
	}

	var removed []string
	for _, item := range items {
		var label string
		switch {
		case item.typ == "Exif":
			label = "iso:exif"
		case item.typ == "mime" && (item.contentType == "application/rdf+xml" || item.contentType == "application/xml"):
			label = "iso:xmp"
		default:
			continue
		}
		wiped := false
		for _, ext := range item.extents {
			offset, length := ext[0], ext[1]
			if offset < 0 || length < 0 || offset+length > len(out) {
				return nil, fmt.Errorf("%s item extent %d+%d is outside the file", label, offset, length)
			}
			// An EXIF item is a four-byte TIFF header offset followed by the
			// TIFF block. Read the orientation before wiping, then write it
			// back, so the image still displays the way it did.
			var minimal []byte
			if item.typ == "Exif" && length > 4 {
				minimal = minimalExif(out[offset+4 : offset+length])
			}
			for i := offset; i < offset+length; i++ {
				out[i] = 0
			}
			if minimal != nil && 4+len(minimal) <= length {
				copy(out[offset+4:offset+length], minimal)
			}
			wiped = true
		}
		if wiped {
			removed = append(removed, label)
		}
	}
	return removed, nil
}

// parseIINF reads the item information box: which item id is EXIF, which is
// XMP, which is the image itself.
func parseIINF(buf []byte, box isoBox, items map[uint32]*isoItem) {
	p := box.payloadStart()
	if p+4 > len(buf) {
		return
	}
	version := buf[p]
	p += 4
	switch version {
	case 0:
		p += 2 // entry_count, 16 bit
	default:
		p += 4 // entry_count, 32 bit
	}

	for _, infe := range iterISOBMFFBoxes(buf, p, box.payloadEnd()) {
		if infe.typ != "infe" {
			continue
		}
		q := infe.payloadStart()
		if q+4 > len(buf) {
			continue
		}
		infeVersion := buf[q]
		q += 4
		if infeVersion < 2 {
			continue // pre-HEIF layout, no item_type to key on
		}

		var itemID uint32
		if infeVersion == 2 {
			if q+2 > len(buf) {
				continue
			}
			itemID = uint32(binary.BigEndian.Uint16(buf[q : q+2]))
			q += 2
		} else {
			if q+4 > len(buf) {
				continue
			}
			itemID = binary.BigEndian.Uint32(buf[q : q+4])
			q += 4
		}
		q += 2 // item_protection_index
		if q+4 > len(buf) {
			continue
		}
		item := &isoItem{typ: string(buf[q : q+4])}
		q += 4
		name, next := readCString(buf, q, infe.payloadEnd())
		_ = name
		if item.typ == "mime" {
			item.contentType, _ = readCString(buf, next, infe.payloadEnd())
		}
		items[itemID] = item
	}
}

func readCString(buf []byte, start, end int) (string, int) {
	if end > len(buf) {
		end = len(buf)
	}
	for i := start; i < end; i++ {
		if buf[i] == 0 {
			return string(buf[start:i]), i + 1
		}
	}
	return "", end
}

// parseILOC reads the item location box, which says where each item's bytes
// live. Only construction method 0 (a plain file offset) is handled; the other
// methods point into boxes we do not rewrite, so those items are left alone.
func parseILOC(buf []byte, box isoBox, items map[uint32]*isoItem) error {
	p := box.payloadStart()
	if p+8 > len(buf) {
		return fmt.Errorf("truncated iloc")
	}
	version := buf[p]
	p += 4

	offsetSize := int(buf[p] >> 4)
	lengthSize := int(buf[p] & 0x0F)
	baseOffsetSize := int(buf[p+1] >> 4)
	indexSize := 0
	if version == 1 || version == 2 {
		indexSize = int(buf[p+1] & 0x0F)
	}
	p += 2

	var itemCount int
	if version < 2 {
		itemCount = int(binary.BigEndian.Uint16(buf[p : p+2]))
		p += 2
	} else {
		itemCount = int(binary.BigEndian.Uint32(buf[p : p+4]))
		p += 4
	}

	readUint := func(size int) (uint64, bool) {
		if size == 0 {
			return 0, true
		}
		if p+size > len(buf) {
			return 0, false
		}
		var v uint64
		for i := 0; i < size; i++ {
			v = v<<8 | uint64(buf[p+i])
		}
		p += size
		return v, true
	}

	for i := 0; i < itemCount; i++ {
		var itemID uint32
		if version < 2 {
			v, ok := readUint(2)
			if !ok {
				return fmt.Errorf("truncated iloc")
			}
			itemID = uint32(v)
		} else {
			v, ok := readUint(4)
			if !ok {
				return fmt.Errorf("truncated iloc")
			}
			itemID = uint32(v)
		}

		constructionMethod := uint64(0)
		if version == 1 || version == 2 {
			v, ok := readUint(2)
			if !ok {
				return fmt.Errorf("truncated iloc")
			}
			constructionMethod = v & 0x0F
		}
		if _, ok := readUint(2); !ok { // data_reference_index
			return fmt.Errorf("truncated iloc")
		}
		baseOffset, ok := readUint(baseOffsetSize)
		if !ok {
			return fmt.Errorf("truncated iloc")
		}
		extentCount, ok := readUint(2)
		if !ok {
			return fmt.Errorf("truncated iloc")
		}

		for e := uint64(0); e < extentCount; e++ {
			if indexSize > 0 {
				if _, ok := readUint(indexSize); !ok {
					return fmt.Errorf("truncated iloc")
				}
			}
			extentOffset, ok := readUint(offsetSize)
			if !ok {
				return fmt.Errorf("truncated iloc")
			}
			extentLength, ok := readUint(lengthSize)
			if !ok {
				return fmt.Errorf("truncated iloc")
			}
			item := items[itemID]
			if item == nil || constructionMethod != 0 {
				continue
			}
			item.extents = append(item.extents, [2]int{int(baseOffset + extentOffset), int(extentLength)})
		}
	}
	return nil
}

// ---------------- TIFF ----------------
//
// TIFF is a chain of tag directories whose values are addressed by absolute
// file offset, so entries are removed by rewriting the directory in place and
// zeroing the value bytes they pointed at. Everything not on the list below is
// left alone: a TIFF can legitimately carry vendor tags that decide how the
// pixels are read.

var tiffMetadataTags = map[uint16]string{
	0x010D: "DocumentName",
	0x010E: "ImageDescription",
	0x010F: "Make",
	0x0110: "Model",
	0x0131: "Software",
	0x0132: "DateTime",
	0x013B: "Artist",
	0x013C: "HostComputer",
	0x02BC: "XMP",
	0x8298: "Copyright",
	0x83BB: "IPTC",
	0x8649: "PhotoshopResources",
	0x8769: "ExifIFD",
	0x8825: "GPSIFD",
	0x9C9B: "XPTitle",
	0x9C9C: "XPComment",
	0x9C9D: "XPAuthor",
	0x9C9E: "XPKeywords",
	0x9C9F: "XPSubject",
	0xA005: "InteropIFD",
}

// tiffSubIFDTags point at another directory rather than holding a value.
var tiffSubIFDTags = map[uint16]bool{0x8769: true, 0x8825: true, 0xA005: true}

var tiffTypeSize = map[uint16]int{1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4, 16: 8, 17: 8, 18: 8}

func stripTIFF(buf []byte) ([]byte, []string, error) {
	order, ifdOffset, ok := tiffByteOrder(buf)
	if !ok {
		return nil, nil, fmt.Errorf("not a TIFF")
	}

	out := append([]byte{}, buf...)
	var removed []string
	seen := map[uint32]bool{}

	for ifdOffset != 0 {
		if seen[ifdOffset] {
			return nil, nil, fmt.Errorf("directory loop at offset %d", ifdOffset)
		}
		seen[ifdOffset] = true

		next, labels, err := stripTIFFDirectory(out, order, int(ifdOffset))
		if err != nil {
			return nil, nil, err
		}
		removed = append(removed, labels...)
		ifdOffset = next
	}
	return out, removed, nil
}

// stripTIFFDirectory rewrites one directory in place and returns the offset of
// the next one. Removing an entry shrinks the directory by twelve bytes, which
// is safe because nothing points into the middle of a directory: the leftover
// bytes at the end become unreferenced slack.
func stripTIFFDirectory(out []byte, order binary.ByteOrder, offset int) (uint32, []string, error) {
	if offset+2 > len(out) {
		return 0, nil, fmt.Errorf("directory at %d is past the end of the file", offset)
	}
	count := int(order.Uint16(out[offset : offset+2]))
	entriesEnd := offset + 2 + count*12
	if entriesEnd+4 > len(out) {
		return 0, nil, fmt.Errorf("directory at %d is truncated", offset)
	}
	next := order.Uint32(out[entriesEnd : entriesEnd+4])

	var removed []string
	kept := make([]byte, 0, count*12)
	for i := 0; i < count; i++ {
		entry := out[offset+2+i*12 : offset+2+(i+1)*12]
		tag := order.Uint16(entry[0:2])
		name, isMetadata := tiffMetadataTags[tag]
		if !isMetadata {
			kept = append(kept, entry...)
			continue
		}
		removed = append(removed, "tiff:"+name)

		if tiffSubIFDTags[tag] {
			blankTIFFDirectory(out, order, int(order.Uint32(entry[8:12])), 0)
			continue
		}
		blankTIFFValue(out, order, entry)
	}

	if len(removed) == 0 {
		return next, nil, nil
	}

	order.PutUint16(out[offset:offset+2], uint16(len(kept)/12))
	copy(out[offset+2:], kept)
	tail := offset + 2 + len(kept)
	order.PutUint32(out[tail:tail+4], next)
	for i := tail + 4; i < entriesEnd+4; i++ {
		out[i] = 0 // slack left by the removed entries
	}
	return next, removed, nil
}

// blankTIFFValue zeroes the bytes an entry's value occupies, whether they are
// stored inline or at an offset.
func blankTIFFValue(out []byte, order binary.ByteOrder, entry []byte) {
	typ := order.Uint16(entry[2:4])
	count := int(order.Uint32(entry[4:8]))
	size, known := tiffTypeSize[typ]
	if !known || count < 0 {
		return
	}
	total := size * count
	if total <= 4 {
		return // inline, and the whole entry is about to disappear
	}
	valueOffset := int(order.Uint32(entry[8:12]))
	if valueOffset < 8 || valueOffset+total > len(out) {
		return
	}
	for i := valueOffset; i < valueOffset+total; i++ {
		out[i] = 0
	}
}

// blankTIFFDirectory wipes a whole sub-directory: its values first, then the
// directory itself.
func blankTIFFDirectory(out []byte, order binary.ByteOrder, offset, depth int) {
	if depth > 4 || offset < 8 || offset+2 > len(out) {
		return
	}
	count := int(order.Uint16(out[offset : offset+2]))
	end := offset + 2 + count*12 + 4
	if count < 0 || end > len(out) {
		return
	}
	for i := 0; i < count; i++ {
		entry := out[offset+2+i*12 : offset+2+(i+1)*12]
		if tiffSubIFDTags[order.Uint16(entry[0:2])] {
			blankTIFFDirectory(out, order, int(order.Uint32(entry[8:12])), depth+1)
			continue
		}
		blankTIFFValue(out, order, entry)
	}
	for i := offset; i < end; i++ {
		out[i] = 0
	}
}
