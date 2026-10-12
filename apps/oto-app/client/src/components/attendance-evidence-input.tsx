import { useEffect, useState } from "react";
import { ATTENDANCE_EVIDENCE_MAX_BYTES, ATTENDANCE_EVIDENCE_TYPES } from "@shared/attendance-evidence";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function AttendanceEvidenceInput({ file, onChange, disabled }: {
  file: File | null; onChange: (file: File | null) => void; disabled: boolean;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!file) { setPreview(null); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return <div className="space-y-2">
    <Label htmlFor="attendance-evidence">Photo or document (optional)</Label>
    <Input id="attendance-evidence" type="file" accept={ATTENDANCE_EVIDENCE_TYPES.join(",")} disabled={disabled}
      data-testid="input-attendance-evidence" onChange={event => {
        const selected = event.target.files?.[0];
        event.target.value = "";
        if (!selected) return;
        if (!(ATTENDANCE_EVIDENCE_TYPES as readonly string[]).includes(selected.type) || !selected.size || selected.size > ATTENDANCE_EVIDENCE_MAX_BYTES) {
          setError("Choose a JPEG, PNG, GIF or PDF no larger than 10 MB.");
          return;
        }
        setError(""); onChange(selected);
      }} />
    <p className="text-xs text-muted-foreground">JPEG, PNG, GIF or PDF, up to 10 MB. Sent with this request for manager review.</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {file && <div className="space-y-2" data-testid="attendance-evidence-preview">
      <p className="text-sm break-all">{file.name}</p>
      {preview && (file.type.startsWith("image/")
        ? <img src={preview} alt="Selected attendance evidence" className="max-h-48 rounded border" />
        : <a href={preview} target="_blank" rel="noreferrer" className="text-sm underline">Preview document</a>)}
      <Button type="button" variant="outline" disabled={disabled} onClick={() => { onChange(null); setError(""); }} data-testid="button-remove-attendance-evidence">Remove attachment</Button>
    </div>}
  </div>;
}
