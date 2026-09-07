import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-medium transition-[background-color,border-color,color,box-shadow,opacity,transform] outline-none motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-(--accent) focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-red aria-invalid:focus-visible:ring-red-t [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "min-h-10 bg-btn-bg text-btn-fg hover:bg-btn-hover active:translate-y-px",
        destructive:
          "min-h-10 border border-red-b bg-card text-red-d hover:border-red hover:bg-red-t",
        outline:
          "min-h-10 border border-border bg-card text-text-2 hover:border-border-2 hover:bg-fill hover:text-text",
        secondary:
          "min-h-10 border border-border bg-fill text-text-2 hover:bg-fill-2 hover:text-text",
        ghost:
          "min-h-10 bg-card text-text-2 hover:bg-fill hover:text-text",
        link: "px-0 text-(--accent) underline-offset-4 hover:underline",
      },
      size: {
        default: "px-4 py-2 has-[>svg]:px-3",
        xs: "min-h-8 gap-1 rounded-lg px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "min-h-9 gap-1.5 rounded-xl px-3 has-[>svg]:px-2.5",
        lg: "min-h-11 rounded-xl px-6 has-[>svg]:px-4",
        icon: "size-10 rounded-full p-0",
        "icon-xs": "size-6 rounded-md p-0 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8 rounded-lg p-0",
        "icon-lg": "size-11 rounded-xl p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
