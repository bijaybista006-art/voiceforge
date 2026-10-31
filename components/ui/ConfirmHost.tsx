"use client";

import { useEffect, useRef } from "react";
import { useConfirmStore } from "@/lib/confirm";
import { Button } from "./Button";
import { Dialog } from "./Dialog";

/** Renders the pending confirmAction() request. Mounted once per layout. */
export function ConfirmHost() {
  const request = useConfirmStore((s) => s.request);
  const settle = useConfirmStore((s) => s.settle);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Focus the safe choice first, so Enter never destroys something by accident.
  useEffect(() => {
    if (request) setTimeout(() => cancelRef.current?.focus(), 0);
  }, [request]);

  return (
    <Dialog
      open={Boolean(request)}
      title={request?.title ?? ""}
      description={request?.body}
      onClose={() => settle(false)}
    >
      <div className="flex flex-wrap justify-end gap-2">
        <Button ref={cancelRef} onClick={() => settle(false)}>
          Cancel
        </Button>
        <Button
          variant={request?.danger ? "dangerSolid" : "primary"}
          onClick={() => settle(true)}
          data-testid="confirm-accept"
        >
          {request?.confirmLabel ?? "Confirm"}
        </Button>
      </div>
    </Dialog>
  );
}
