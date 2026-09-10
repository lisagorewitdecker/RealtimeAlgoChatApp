import * as React from "react"
import { Loader2Icon } from "lucide-react"

import { cn } from "@/lib/utils"

const Spinner = React.forwardRef<
  SVGSVGElement,
  React.ComponentPropsWithoutRef<typeof Loader2Icon>
>(({ className, ...props }, ref) => {
  return (
    <Loader2Icon
      role="status"
      aria-label="Loading"
      className={cn("size-4 animate-spin", className)}
      {...props}
      ref={ref}
    />
  )
})

Spinner.displayName = "Spinner"

export { Spinner }
