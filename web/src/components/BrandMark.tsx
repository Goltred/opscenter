import { PRODUCT_BRAND } from "../theme/catalog";

export function BrandMark({ className = "brand" }: { className?: string }) {
  return (
    <div className={className}>
      {PRODUCT_BRAND.mark}
      <span>{PRODUCT_BRAND.accentPart}</span>
    </div>
  );
}
