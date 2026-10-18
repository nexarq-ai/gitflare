export function BrandMark({ size = 28 }: { size?: number }) {
  return <><img className="gf-brand-tile" src="/logo.svg" alt="" width={size} height={size} /><span className="gf-brand-name">Git<em>flare</em></span></>;
}
