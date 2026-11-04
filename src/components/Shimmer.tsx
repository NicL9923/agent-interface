/** Live work's sentence, with a band of light passing over it. Styled in styles.css. */
export function Shimmer({ text }: { text: string }) {
  return <span className="activity-shimmer">{text}<span className="shimmer-band" aria-hidden="true"><span>{text}</span></span></span>;
}
