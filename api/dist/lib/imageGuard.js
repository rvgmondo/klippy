/**
 * Is this actually a usable image?
 *
 * Found the hard way. A business had a 70-byte "logo" that was a truncated PNG: a
 * valid header followed by a final chunk declaring a length of 2.3 GB. pdfkit hands
 * that to its PNG reader, which tries to read the declared length out of a 70-byte
 * buffer and spends about FIFTY SECONDS before finally throwing "Incomplete or
 * corrupt PNG file".
 *
 * The throw was already caught, so nothing broke visibly. What it cost was time:
 * every invoice PDF for that business took a minute, which means every emailed
 * invoice, every reminder attachment and the whole nightly reminder run. Rendering
 * the same document without the logo takes 20ms.
 *
 * So images are checked before pdfkit ever sees them: on upload, so a bad file is
 * refused with a clear message, and again at render, because bad files are already
 * stored and other people's installs will have them too.
 */
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Well beyond any sane logo, but low enough that decoding cannot run away. */
const MAX_DIMENSION = 10000;
function checkPng(buf) {
    if (buf.length < 57)
        return { ok: false, reason: 'The file is too small to be a real PNG.' };
    if (!buf.subarray(0, 8).equals(PNG_SIG))
        return { ok: false, reason: 'Not a PNG.' };
    if (buf.toString('ascii', 12, 16) !== 'IHDR')
        return { ok: false, reason: 'The PNG header is missing.' };
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    if (!width || !height)
        return { ok: false, reason: 'The image reports no size.' };
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
        return { ok: false, reason: `That image is ${width}x${height}. Please use something under ${MAX_DIMENSION}px.` };
    }
    // Walk every chunk. This is what catches the truncated file: a chunk whose
    // declared length runs past the end of the buffer is the exact shape that costs
    // pdfkit a minute, and it is cheap to spot here.
    let off = 8;
    let sawEnd = false;
    while (off + 12 <= buf.length) {
        const len = buf.readUInt32BE(off);
        const type = buf.toString('ascii', off + 4, off + 8);
        if (!/^[a-zA-Z]{4}$/.test(type))
            return { ok: false, reason: 'The PNG is damaged.' };
        // + 12 for the length, type and CRC fields around the data.
        if (len > buf.length || off + 12 + len > buf.length) {
            return { ok: false, reason: 'The PNG is truncated or damaged. Try re-exporting it.' };
        }
        if (type === 'IEND') {
            sawEnd = true;
            break;
        }
        off += 12 + len;
    }
    if (!sawEnd)
        return { ok: false, reason: 'The PNG is incomplete. Try re-exporting it.' };
    return { ok: true, width, height, kind: 'png' };
}
function checkJpeg(buf) {
    if (buf.length < 4)
        return { ok: false, reason: 'The file is too small to be a real JPEG.' };
    if (buf[0] !== 0xff || buf[1] !== 0xd8)
        return { ok: false, reason: 'Not a JPEG.' };
    // Walk the markers to the frame header, which carries the dimensions.
    let off = 2;
    while (off + 4 <= buf.length) {
        if (buf[off] !== 0xff)
            return { ok: false, reason: 'The JPEG is damaged.' };
        const marker = buf[off + 1];
        if (marker === 0xd9)
            break; // end of image
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            off += 2;
            continue;
        }
        const len = buf.readUInt16BE(off + 2);
        if (len < 2 || off + 2 + len > buf.length) {
            return { ok: false, reason: 'The JPEG is truncated or damaged. Try re-exporting it.' };
        }
        // SOF0..SOF15, excluding the non-frame markers in that range.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            const height = buf.readUInt16BE(off + 5);
            const width = buf.readUInt16BE(off + 7);
            if (!width || !height)
                return { ok: false, reason: 'The image reports no size.' };
            if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
                return { ok: false, reason: `That image is ${width}x${height}. Please use something under ${MAX_DIMENSION}px.` };
            }
            return { ok: true, width, height, kind: 'jpeg' };
        }
        off += 2 + len;
    }
    return { ok: false, reason: 'The JPEG has no image data.' };
}
/**
 * Check an image is complete and sane before anything tries to decode it. Only PNG
 * and JPEG, which are the two formats pdfkit can embed.
 */
export function checkImage(buf) {
    if (!buf || buf.length < 8)
        return { ok: false, reason: 'The file is empty.' };
    if (buf.subarray(0, 8).equals(PNG_SIG))
        return checkPng(buf);
    if (buf[0] === 0xff && buf[1] === 0xd8)
        return checkJpeg(buf);
    return { ok: false, reason: 'Please use a PNG or JPEG.' };
}
/** The buffer if it is safe to hand to a renderer, otherwise null. */
export function safeImage(buf) {
    if (!buf)
        return null;
    return checkImage(buf).ok ? buf : null;
}
//# sourceMappingURL=imageGuard.js.map