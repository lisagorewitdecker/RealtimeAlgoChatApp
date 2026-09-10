import * as React from "react"
import { Loader2Icon } from "lucide-react"

import { cn } from "@/lib/utils"

function Spinner({
  className,
  ref,
  ...props
}: React.ComponentPropsWithRef<"svg">) {
  const setRef: React.RefCallback<SVGSVGElement> = (node) => {
    if (typeof ref === "function") {
      ref(node)
      return
    }

    if (ref && typeof ref === "object") {
      ;(ref as React.MutableRefObject<SVGSVGElement | null>).current = node
    }
  }

  return (
    <Loader2Icon
      role="status"
      aria-label="Loading"
      className={cn("size-4 animate-spin", className)}
      {...props}
      ref={setRef}
    />
  )
}

export { Spinner }
