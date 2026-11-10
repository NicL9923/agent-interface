/** An image's natural size in pixels. */
export type ImageSize = { width: number; height: number };
/**
 * The natural sizes of images this page has shown, by file ID, so a transcript image can reserve its space before it
 * loads. Hermes reports no image sizes. The composer records each attachment's size from its preview, so the person's
 * own images know theirs from the moment they are sent; any other image learns its size the first time it loads here.
 */
const sizes = new Map<string, ImageSize>();
export const imageSize = (id: string): ImageSize | undefined => sizes.get(id);
/** Keeps a loaded image's natural size. An image without one, such as a broken file, is not kept. */
export function rememberImageSize(id: string, image: Pick<HTMLImageElement, "naturalWidth" | "naturalHeight">) {
  if (image.naturalWidth > 0 && image.naturalHeight > 0) sizes.set(id, { width: image.naturalWidth, height: image.naturalHeight });
}
