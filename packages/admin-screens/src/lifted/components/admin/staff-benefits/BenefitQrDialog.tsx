import { useAdminScreenRuntime } from '../../../runtime/AdminScreenRuntime';
import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from 'qrcode';
import { QrCode as QrCodeIcon, ShieldOff } from "lucide-react";
import { type BenefitCredential, type BenefitQrPayload, type StaffBenefitRow } from "../../../api/benefits";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "../../ui/dialog";
import { Button } from "../../ui/button";
import { useBenefitIdentity, type BenefitQrDialogPorts } from '../../../runtime/benefits';
import { idemKey } from '../../../api/client';

/**
 * Shows a staff member's scannable benefit QR.
 *
 * The prototype's dialog — the person's name as the title, the line "Scan at
 * the F&B order station…", the QR and the code under it in small mono type —
 * is kept as it was. S2-21 round 2 (SCRUM-218) puts the platform's credential
 * behind it: the code is now a QR the platform signed (`OTO-BEN:v1:…`,
 * `GET /benefits/credentials/:id/qr`), drawn as a real, scannable QR — the
 * prototype's `<QrCode>` is a stylised pattern no scanner can read, and this
 * one has to open the box's scanner. The same swap the booking confirmation
 * made for the signed booking QR.
 *
 * UI additions, in the dialog's own style (plan §1: "a revoke button for a
 * QR"): who may issue sees "Issue QR" when the person has none, the date the
 * QR is good until, and "Revoke QR" with a confirmation. Somebody who may
 * only read the screen — a branch manager — sees whether a QR is in use and
 * until when, and never the code: the printed code is the credential.
 */
interface QrProps {
  staff: StaffBenefitRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `admin:benefit:credential_issue`: print, issue and revoke. */
  canIssue: boolean;
}
export function BenefitQrDialog(props: QrProps) {
  const runtime = useAdminScreenRuntime();
  return <BenefitQrDialogWithPorts {...props} ports={{ contextKey: runtime.session.operator?.id ?? '', api: runtime.api.benefits }} />;
}
export function BenefitQrDialogWithPorts({ staff, open, onOpenChange, canIssue, ports }: QrProps & { ports: BenefitQrDialogPorts }) {
  const benefitsApi = ports.api;
  const identity = useBenefitIdentity(ports.contextKey + '|' + (staff?.employeeId ?? '') + '|' + open + '|' + canIssue);
  const identityRef = useRef(identity), staffRef = useRef(staff?.employeeId), openRef = useRef(open), issueRef = useRef(canIssue), mounted = useRef(true), requestEpoch = useRef(0), busyRef = useRef(false);
  identityRef.current = identity; staffRef.current = staff?.employeeId; openRef.current = open; issueRef.current = canIssue;
  const credentialOwnerRef = useRef(''), payloadOwnerRef = useRef('');
  const intentRef = useRef<{ identity: string; action: string; key: string; confirmed: boolean } | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; requestEpoch.current++; }; }, []);

  const [heldCredential, setCredential] = useState<BenefitCredential | null>(null);
  const [heldPayload, setPayload] = useState<BenefitQrPayload | null>(null);
  const credential = credentialOwnerRef.current === identity ? heldCredential : null;
  const payload = canIssue && payloadOwnerRef.current === identity ? heldPayload : null;
  const [image, setImage] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (employeeId: string) => {
      const request = ++requestEpoch.current, requestIdentity = identityRef.current;
      const owns = () => mounted.current && requestEpoch.current === request && identityRef.current === requestIdentity && staffRef.current === employeeId && openRef.current;
      if (!owns()) return false;
      setLoading(true);
      setError(null);
      setPayload(null);
      payloadOwnerRef.current = '';
      setConfirmRevoke(false);
      try {
        const { credentials } = await benefitsApi.credentials(employeeId);
        if (!owns()) return false;
        const active = credentials.find((c) => c.status === 'active') ?? null;
        credentialOwnerRef.current = requestIdentity;
        setCredential(active);
        if (active && issueRef.current) {
          const answer = await benefitsApi.credentialQr(active.id);
          if (!owns() || !issueRef.current) return false;
          if (answer.employeeId !== employeeId || answer.credentialId !== active.id) throw new Error('The benefit QR did not match this staff member.');
          payloadOwnerRef.current = requestIdentity;
          setPayload(answer);
        }
        return true;
      } catch (err) {
        if (owns()) setError(err instanceof Error ? err.message : 'Could not load the benefit QR');
        return false;
      } finally {
        if (owns()) setLoading(false);
      }
    },
    [benefitsApi],
  );

  useEffect(() => {
    requestEpoch.current++;
    intentRef.current = null; busyRef.current = false;
    credentialOwnerRef.current = ''; payloadOwnerRef.current = '';
    setBusy(false); setCredential(null); setPayload(null); setError(null); setConfirmRevoke(false);
    if (openRef.current && staffRef.current) void load(staffRef.current);
  }, [identity, load]);

  useEffect(() => {
    let current = true;
    setImage('');
    if (!payload) return;
    QRCode.toDataURL(payload.code, { margin: 1, width: 384, errorCorrectionLevel: 'M' })
      .then((url) => {
        if (current) setImage(url);
      })
      .catch(() => {
        if (current) setImage('');
      });
    return () => {
      current = false;
    };
  }, [payload]);

  const issue = async () => {
    if (!staff || busyRef.current || !mounted.current || !openRef.current || !issueRef.current || identityRef.current !== identity || staffRef.current !== staff.employeeId) return;
    const requestIdentity = identity, employeeId = staff.employeeId;
    const owns = () => mounted.current && identityRef.current === requestIdentity && staffRef.current === employeeId && openRef.current && issueRef.current;
    if (intentRef.current?.identity !== requestIdentity || intentRef.current.action !== 'issue') intentRef.current = { identity: requestIdentity, action: 'issue', key: idemKey(), confirmed: false };
    const intent = intentRef.current;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      if (!intent.confirmed) { await benefitsApi.issueCredential(employeeId, intent.key); intent.confirmed = true; }
      if (!owns()) return;
      if (await load(employeeId)) intentRef.current = null;
      else if (owns()) setError('Issued, but the QR could not be read. Issue QR again to retry the read without issuing another.');
    } catch (err) {
      if (owns()) setError(err instanceof Error ? err.message : 'The QR could not be issued');
    } finally {
      if (mounted.current && identityRef.current === requestIdentity) { busyRef.current = false; setBusy(false); }
    }
  };

  const revoke = async () => {
    if (!staff || !credential || busyRef.current || !mounted.current || !openRef.current || !issueRef.current || identityRef.current !== identity || staffRef.current !== staff.employeeId) return;
    const requestIdentity = identity, employeeId = staff.employeeId, credentialId = credential.id;
    const owns = () => mounted.current && identityRef.current === requestIdentity && staffRef.current === employeeId && openRef.current && issueRef.current;
    if (intentRef.current?.identity !== requestIdentity || intentRef.current.action !== credentialId) intentRef.current = { identity: requestIdentity, action: credentialId, key: idemKey(), confirmed: false };
    const intent = intentRef.current;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      if (!intent.confirmed) { await benefitsApi.revokeCredential(credentialId, intent.key); intent.confirmed = true; }
      if (!owns()) return;
      if (await load(employeeId)) intentRef.current = null;
      else if (owns()) setError('Revoked, but the current QR status could not be read. Revoke QR again to retry the read without another change.');
    } catch (err) {
      if (owns()) setError(err instanceof Error ? err.message : 'The QR could not be revoked');
    } finally {
      if (mounted.current && identityRef.current === requestIdentity) { busyRef.current = false; setBusy(false); setConfirmRevoke(false); }
    }
  };
  const changeOpen = (next: boolean) => {
    if (!next) { identityRef.current += '|closed'; openRef.current = false; requestEpoch.current++; setPayload(null); payloadOwnerRef.current = ''; }
    onOpenChange(next);
  };

  const until = credential ? new Date(credential.expiresAt).toLocaleDateString() : null;

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="max-w-xs">
        <DialogHeader>
          <DialogTitle>{payload?.name ?? staff?.name ?? 'Benefit QR'}</DialogTitle>
          <DialogDescription>
            Scan at the F&amp;B order station to apply this staff member's benefit.
          </DialogDescription>
        </DialogHeader>
        {staff && (
          <div className="flex flex-col items-center gap-3 py-2">
            {loading ? (
              <p className="text-sm text-foreground/50">Loading…</p>
            ) : payload ? (
              <>
                <div className="h-48 w-48 shrink-0 rounded-lg bg-white p-1.5">
                  {image && (
                    <img
                      src={image}
                      alt={`Benefit QR for ${payload.name}`}
                      className="h-full w-full"
                      data-testid="benefit-qr"
                    />
                  )}
                </div>
                <span className="break-all text-center font-mono text-xs text-foreground/50">
                  {payload.code}
                </span>
              </>
            ) : credential ? (
              <div className="flex flex-col items-center gap-1 text-center text-sm text-foreground/60">
                <QrCodeIcon className="h-8 w-8 text-foreground/30" />
                <span>A benefit QR is in use.</span>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-1 text-center text-sm text-foreground/60">
                <QrCodeIcon className="h-8 w-8 text-foreground/30" />
                <span>No benefit QR has been issued.</span>
              </div>
            )}

            {!loading && until && (
              <span className="text-xs text-foreground/40">Valid until {until}</span>
            )}

            {error && <p className="text-center text-sm text-destructive">{error}</p>}

            {canIssue && !loading && (
              <div className="flex w-full flex-col items-stretch gap-2 border-t border-foreground/10 pt-3">
                {!credential && (
                  <Button onClick={() => void issue()} disabled={busy}>
                    <QrCodeIcon className="w-4 h-4" />
                    Issue QR
                  </Button>
                )}
                {credential && !confirmRevoke && (
                  <Button variant="outline" onClick={() => setConfirmRevoke(true)} disabled={busy}>
                    <ShieldOff className="w-4 h-4" />
                    Revoke QR
                  </Button>
                )}
                {credential && confirmRevoke && (
                  <>
                    <p className="text-center text-xs text-foreground/50">
                      It stops working on the platform at once, and on each box from its next
                      update.
                    </p>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        className="flex-1"
                        onClick={() => setConfirmRevoke(false)}
                        disabled={busy}
                      >
                        Keep
                      </Button>
                      <Button
                        variant="destructive"
                        className="flex-1"
                        onClick={() => void revoke()}
                        disabled={busy}
                      >
                        Revoke
                      </Button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
