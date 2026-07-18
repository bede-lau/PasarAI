import { ShoppingBasket } from "lucide-react";

type BrandMarkProps = {
  className?: string;
};

export function BrandMark({ className = "brand-mark" }: BrandMarkProps) {
  return (
    <span className={className} aria-hidden="true">
      <ShoppingBasket strokeWidth={1.8} />
    </span>
  );
}
