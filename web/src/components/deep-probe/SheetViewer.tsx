import { useMemo, useState } from "react";
import { ChevronLeft } from "lucide-react";

import type { SheetBlock, SheetSection } from "@/lib/deep-probe/sheets";
import { cn } from "@/lib/utils";

const TONE_CLASS: Record<string, string> = {
  ok: "text-emerald-300",
  warn: "text-amber-200",
  bad: "text-rose-300",
  muted: "text-muted-foreground",
};

function Block({ block }: { block: SheetBlock }) {
  if (block.kind === "prose") {
    return <p className="text-[11.5px] leading-relaxed text-muted-foreground">{block.text}</p>;
  }
  if (block.kind === "mono") {
    return (
      <pre className="mono max-h-[60vh] overflow-auto rounded-xl border border-border/60 bg-background/60 p-2.5 text-[9.5px] leading-[1.5] whitespace-pre-wrap break-words">
        {block.text}
      </pre>
    );
  }
  if (block.kind === "rows") {
    return (
      <div className="overflow-hidden rounded-xl border border-border/60">
        {block.rows.map((row, index) => (
          <div
            key={`${row.label}-${index}`}
            className={cn("grid grid-cols-[minmax(96px,38%)_1fr] gap-2 px-2.5 py-1.5 text-[10.5px] leading-relaxed", index % 2 === 1 ? "bg-background/40" : "")}
          >
            <span className="text-muted-foreground">{row.label}</span>
            <span className={cn("mono break-words", TONE_CLASS[row.tone ?? ""] ?? "text-foreground")}>{row.value}</span>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full border-collapse text-[10px]">
        <thead>
          <tr>
            {block.head.map((head) => (
              <th key={head} className="whitespace-nowrap border-b border-border/60 px-1.5 py-1.5 text-left text-[8.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                {head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, index) => (
            <tr key={index}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="border-b border-border/40 px-1.5 py-1.5 align-top leading-relaxed">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The sheet, on screen, with no download and no archive involved.
 *
 * It renders the very same section registry the downloadable sheet and the HTML
 * page are rendered from, so what is read here cannot drift from what is saved.
 */
export function SheetViewer({ sections }: { sections: SheetSection[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = useMemo(() => sections.find((section) => section.id === openId) ?? null, [sections, openId]);

  if (open) {
    return (
      <div className="diag-card overflow-hidden">
        <button
          type="button"
          onClick={() => setOpenId(null)}
          className="flex w-full items-center gap-1.5 border-b border-border/60 px-3 py-2.5 text-left text-[11px] font-semibold active:scale-[0.99]"
        >
          <ChevronLeft className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="truncate">{open.title}</span>
        </button>
        <div className="space-y-2.5 p-3">
          <p className="text-[10.5px] leading-relaxed text-muted-foreground">{open.blurb}</p>
          {open.blocks.map((block, index) => (
            <Block key={index} block={block} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="diag-card overflow-hidden">
      <div className="border-b border-border/60 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        Look through it here
      </div>
      <div className="divide-y divide-border/50">
        {sections.map((section) => (
          <button
            key={section.id}
            type="button"
            onClick={() => setOpenId(section.id)}
            className="flex w-full flex-col items-start gap-0.5 px-3 py-2.5 text-left active:bg-background/60"
          >
            <span className="text-[12px] font-semibold">{section.title}</span>
            <span className="line-clamp-2 text-[10px] leading-relaxed text-muted-foreground">{section.blurb}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
