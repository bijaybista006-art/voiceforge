"use client";

import { forwardRef, type ButtonHTMLAttributes } from "react";

type Variant = "primary" | "video" | "secondary" | "ghost" | "danger" | "dangerSolid";
type Size = "sm" | "md" | "lg";

const VARIANTS: Record<Variant, string> = {
  // Primary = the speech/brand action. Solid blue, white text.
  primary:
    "bg-brand-600 text-white font-semibold hover:bg-[rgb(29_78_216)] shadow-[0_4px_14px_-4px_rgba(37,99,235,.45)]",
  // Same weight, for the video half of the product.
  video:
    "bg-accent-600 text-white font-semibold hover:bg-accent-500 shadow-[0_4px_14px_-4px_rgba(124,58,237,.45)]",
  secondary:
    "border border-line bg-surface text-ink hover:border-lineStrong hover:bg-surface2",
  ghost: "text-muted hover:text-ink hover:bg-surface3",
  danger: "border border-danger/30 bg-dangerSoft text-danger hover:border-danger/60",
  // The confirm button of a destructive dialog: unmistakable.
  dangerSolid: "bg-[rgb(220_38_38)] text-white font-semibold hover:bg-[rgb(185_28_28)]",
};

const SIZES: Record<Size, string> = {
  sm: "h-8 px-3 text-[13px] rounded-lg gap-1.5",
  md: "h-10 px-4 text-sm rounded-xl gap-2",
  lg: "h-12 px-6 text-[15px] rounded-xl gap-2",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", className = "", type = "button", ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={`inline-flex select-none items-center justify-center whitespace-nowrap transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...props}
    />
  );
});
