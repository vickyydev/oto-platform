import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ExternalLink, Ticket } from "lucide-react";
import { CONSOLE_URL } from "@/lib/other-apps";

/**
 * What every address of the old voucher module shows now.
 *
 * Vouchers are a platform matter: the Console holds the voucher types and the
 * ledger of every slip, whatever issued it, and the POS tills redeem them.
 * The pages that lived at these addresses drove a voucher store of this
 * app's own that nothing else reads, so they were switched off rather than
 * left running beside the real one. The addresses stay so a bookmark or an
 * old link lands on this explanation instead of a 404. The server's routes
 * and the tables behind them are untouched; the old data is still there.
 */
export default function VouchersMovedPage() {
  return (
    <div className="p-4 max-w-lg mx-auto">
      <Card data-testid="card-vouchers-moved">
        <CardContent className="flex flex-col items-center py-10 px-6 text-center">
          <div className="rounded-full bg-muted p-4 mb-4">
            <Ticket className="h-8 w-8 text-muted-foreground" />
          </div>
          <h1 className="text-lg font-semibold mb-2" data-testid="text-vouchers-moved-title">
            Vouchers have moved to the Console
          </h1>
          <p className="text-sm text-muted-foreground max-w-sm" data-testid="text-vouchers-moved-detail">
            Voucher types and the ledger are managed there; slips are redeemed at the POS tills.
          </p>
          <Button className="mt-6" asChild data-testid="link-open-console">
            <a href={CONSOLE_URL} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="mr-2 h-4 w-4" />
              Open the Console
            </a>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
