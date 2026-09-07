import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-10 w-full min-w-0 rounded-xl border border-border bg-card px-3.5 py-2 text-sm text-text shadow-xs transition-[color,border-color,box-shadow,background-color] outline-none selection:bg-(--accent) selection:text-btn-fg placeholder:text-text-3 disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none",
        "hover:border-border-2 focus-visible:border-(--accent) focus-visible:ring-2 focus-visible:ring-(--accent) focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        "aria-invalid:border-red aria-invalid:focus-visible:ring-red-t",
        className
      )}
      {...props}
    />
  )
}

export { Input }
