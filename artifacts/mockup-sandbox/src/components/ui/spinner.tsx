import * as React from "react"
import { Loader2Icon } from "lucide-react"

import { cn } from "@/lib/utils"

function Spinner({ className, ref, ...props }: React.ComponentProps<"svg">) {
  const setRef: React.RefCallback<SVGSVGElement> = (node) => {
    if (typeof ref === "function") {
      return ref(node) as unknown as ReturnType<
        React.RefCallback<SVGSVGElement>
      >
    }

    if (ref) {
      ref.current = node
    }
  }

  return (
    <Loader2Icon
      role="status"
      aria-label="Loading"
      className={cn("size-4 animate-spin", className)}
      {...props}
      ref={
        setRef as unknown as React.ComponentProps<typeof Loader2Icon>["ref"]
      }
    />
  )
}

export { Spinner }
