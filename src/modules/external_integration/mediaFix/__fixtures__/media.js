/** Media-library fixtures shaped like WordPress's own REST media items (context=edit). */

export const SITE = 'https://clinic.example';
export const UPLOADS = `${SITE}/wp-content/uploads`;

/** An attachment with the generated sizes WordPress writes for an uploaded image. */
export function mediaItem(id, file, over = {}) {
  const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
  const name = file.slice(file.lastIndexOf('/') + 1);
  const stem = name.replace(/\.[a-z0-9]+$/i, '');
  const ext = name.slice(stem.length);
  const sized = (w, h) => ({ file: `${stem}-${w}x${h}${ext}`, width: w, height: h, source_url: `${UPLOADS}/${dir ? `${dir}/` : ''}${stem}-${w}x${h}${ext}` });
  return {
    id,
    source_url: `${UPLOADS}/${file}`,
    alt_text: '',
    caption: { raw: '', rendered: '' },
    post: 0,
    media_type: 'image',
    mime_type: 'image/jpeg',
    media_details: { file, width: 1600, height: 1067, sizes: { medium: sized(300, 200), large: sized(768, 512), full: { file: name, source_url: `${UPLOADS}/${file}` } } },
    ...over,
  };
}

/** What the crawler stores in a finding's before_snapshot. */
export function snapshot(over = {}) {
  return {
    type: 'image_alt', src: `${UPLOADS}/2024/10/dr-rao.jpg`, imageUrl: `${UPLOADS}/2024/10/dr-rao.jpg`, alt: null,
    altState: 'missing', wpAttachmentId: null, srcsetUrls: [], lazySrc: null, role: null, ariaHidden: false, inLink: false,
    figcaption: null, linkText: null, linkTitle: null,
    ...over,
  };
}
