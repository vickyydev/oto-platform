import { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { SopArticle, SopArticleRevision, SopRevisionSummary } from "@shared/schema";

type Detail = Pick<SopArticleRevision, "id" | "version" | "content" | "previousStatus" | "savedByName" | "savedAt">;

export function SopHistory({ article, onRestored }: { article: SopArticle; onRestored: (article: SopArticle) => void }) {
  const [before, setBefore] = useState<number | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const held = useRef<{ key: string; mutationId: string } | null>(null);
  const { toast } = useToast();
  const base = `/api/sops/${article.id}/revisions`;
  const history = useQuery<{ items: SopRevisionSummary[]; nextBeforeVersion: number | null }>({
    queryKey: ["/api/sops", article.id, "revisions", before],
    queryFn: async () => (await apiRequest("GET", base + (before === null ? "" : `?beforeVersion=${before}`))).json(),
  });
  const detail = useQuery<Detail>({
    queryKey: ["/api/sops", article.id, "revision", selected],
    queryFn: async () => (await apiRequest("GET", `${base}/${selected}`)).json(),
    enabled: selected !== null,
  });
  const restore = useMutation({
    mutationFn: async (revisionId: string): Promise<SopArticle> => {
      const key = `${article.id}:${article.editVersion}:${revisionId}`;
      if (held.current?.key !== key) held.current = { key, mutationId: crypto.randomUUID() };
      return (await apiRequest("POST", `${base}/${revisionId}/restore`, {
        expectedVersion: article.editVersion, mutationId: held.current.mutationId,
      })).json();
    },
    onSuccess: saved => {
      queryClient.invalidateQueries({ queryKey: ["/api/sops"] });
      queryClient.invalidateQueries({ queryKey: [`/api/sops/${article.id}`] });
      toast({ title: "SOP content restored", description: "Publication status and branch visibility are unchanged." });
      onRestored(saved);
    },
    onError: (error: Error) => toast({ title: "Could not restore this version", description: error.message, variant: "destructive" }),
  });
  return <div className="space-y-3" data-testid="sop-history">
    <p className="text-sm text-muted-foreground">Previous content is saved before each change. Restoring keeps the current publication status and branch visibility.</p>
    {history.isLoading && <p role="status">Loading history...</p>}
    {history.error && <p role="alert">{history.error.message}</p>}
    {history.data?.items.length === 0 && <p>No previous versions have been saved.</p>}
    {history.data?.items.map(row => <Card key={row.id}>
      <CardContent className="p-3 space-y-1">
        <p className="font-medium">Version {row.version}: {row.title}</p>
        <p className="text-xs text-muted-foreground">Saved before a change by {row.savedByName} · {new Date(row.savedAt).toLocaleString()} · {row.previousStatus}</p>
        <Button size="sm" variant="outline" onClick={() => setSelected(row.id)} disabled={restore.isPending}>View version</Button>
      </CardContent>
    </Card>)}
    <div className="flex gap-2">
      {before !== null && <Button variant="outline" size="sm" onClick={() => { setBefore(null); setSelected(null); }}>Newest versions</Button>}
      {history.data?.nextBeforeVersion != null && <Button variant="outline" size="sm" onClick={() => { setBefore(history.data!.nextBeforeVersion); setSelected(null); }}>Older versions</Button>}
    </div>
    {detail.isFetching && selected && <p role="status">Loading version...</p>}
    {detail.error && <p role="alert">{detail.error.message}</p>}
    {detail.data && <Card><CardContent className="p-3 space-y-3" data-testid="sop-history-preview">
      <h3 className="font-semibold">{detail.data.content.title}</h3>
      {detail.data.content.coverImageUrl && <img src={detail.data.content.coverImageUrl} alt={detail.data.content.title} className="max-h-64 max-w-full object-contain" />}
      {detail.data.content.summary && <p>{detail.data.content.summary}</p>}
      <p className="text-xs text-muted-foreground">{detail.data.content.departments?.join(", ")} · {detail.data.content.readingTime ?? 3} min read</p>
      <p className="whitespace-pre-wrap">{detail.data.content.body}</p>
      {(detail.data.content.structuredSteps ?? []).map(step => <div key={step.stepNumber}>
        <p className="font-medium">{step.stepNumber}. {step.title}</p><p className="whitespace-pre-wrap">{step.description}</p>
        {step.imageUrl && <img src={step.imageUrl} alt={step.title} className="max-h-64 max-w-full object-contain" />}
      </div>)}
      {!detail.data.content.structuredSteps?.length && (detail.data.content.steps ?? []).map((step, index) => <p key={index}>{index + 1}. {step}</p>)}
      {([
        ["Rules", detail.data.content.rules],
        ["Things to avoid", detail.data.content.commonMistakes],
        ["When unsure", detail.data.content.unsureTips],
      ] as const).map(([label, lines]) => lines?.length ? <div key={label}>
        <h4 className="font-medium">{label}</h4>
        <ul className="list-disc pl-5">{lines.map((line, index) => <li key={index}>{line}</li>)}</ul>
      </div> : null)}
      <Button onClick={() => restore.mutate(detail.data!.id)} disabled={restore.isPending} data-testid="button-restore-sop-version">
        {restore.isPending ? "Restoring..." : "Restore this content"}
      </Button>
    </CardContent></Card>}
  </div>;
}
