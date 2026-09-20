import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { 
  Plus, 
  Loader2, 
  Trash2, 
  Copy, 
  Check,
  Link,
  Key,
  Building2,
  Clock,
  AlertCircle,
  ExternalLink,
} from "lucide-react";
import { format, parseISO, formatDistanceToNow } from "date-fns";
import { useBranchContext } from "@/hooks/use-branch-context";
import { LoadingSpinner } from "@/components/ui/loading-spinner";

interface SupplierToken {
  id: string;
  tenantId: string;
  name: string;
  allowedBranchIds: string[];
  expiresAt?: string | null;
  createdAt: string;
  lastAccessedAt?: string | null;
  createdByUserId: string;
  isActive: boolean;
}

interface NewTokenResponse {
  id: string;
  name: string;
  token: string;
  allowedBranchIds: string[];
  expiresAt?: string | null;
  createdAt: string;
  magicLink: string;
}

export default function SupplierTokensPage() {
  const { toast } = useToast();
  const { branches } = useBranchContext();
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showSuccessDialog, setShowSuccessDialog] = useState(false);
  const [newTokenData, setNewTokenData] = useState<NewTokenResponse | null>(null);
  const [tokenToDelete, setTokenToDelete] = useState<SupplierToken | null>(null);
  const [copied, setCopied] = useState(false);
  
  const [newName, setNewName] = useState("");
  const [selectedBranches, setSelectedBranches] = useState<string[]>([]);
  const [expiresIn, setExpiresIn] = useState<string>("");
  
  const { data: tokens = [], isLoading } = useQuery<SupplierToken[]>({
    queryKey: ["/api/settings/supplier-tokens"],
  });
  
  const createTokenMutation = useMutation({
    mutationFn: async () => {
      let expiresAt = null;
      if (expiresIn) {
        const days = parseInt(expiresIn);
        if (!isNaN(days) && days > 0) {
          const exp = new Date();
          exp.setDate(exp.getDate() + days);
          expiresAt = exp.toISOString();
        }
      }
      
      const res = await apiRequest("/api/settings/supplier-tokens", {
        method: "POST",
        body: JSON.stringify({
          name: newName.trim(),
          allowedBranchIds: selectedBranches,
          expiresAt,
        }),
      });
      return res as NewTokenResponse;
    },
    onSuccess: (data) => {
      setNewTokenData(data);
      setShowCreateDialog(false);
      setShowSuccessDialog(true);
      setNewName("");
      setSelectedBranches([]);
      setExpiresIn("");
      queryClient.invalidateQueries({ queryKey: ["/api/settings/supplier-tokens"] });
      toast({ title: "Supplier token created" });
    },
    onError: () => {
      toast({ title: "Failed to create token", variant: "destructive" });
    },
  });
  
  const deleteTokenMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest(`/api/settings/supplier-tokens/${id}`, {
        method: "DELETE",
      });
    },
    onSuccess: () => {
      setTokenToDelete(null);
      queryClient.invalidateQueries({ queryKey: ["/api/settings/supplier-tokens"] });
      toast({ title: "Token revoked" });
    },
    onError: () => {
      toast({ title: "Failed to revoke token", variant: "destructive" });
    },
  });
  
  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast({ title: "Copied to clipboard" });
    } catch {
      toast({ title: "Failed to copy", variant: "destructive" });
    }
  };
  
  const toggleBranch = (branchId: string) => {
    setSelectedBranches(prev => 
      prev.includes(branchId) 
        ? prev.filter(id => id !== branchId)
        : [...prev, branchId]
    );
  };
  
  const getBranchNames = (branchIds: string[]) => {
    return branchIds
      .map(id => branches.find(b => b.id === id)?.name || id)
      .join(", ");
  };
  
  return (
    <div className="container max-w-4xl py-6" data-testid="page-supplier-tokens">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Key className="w-6 h-6" />
            Supplier Access Tokens
          </h1>
          <p className="text-muted-foreground mt-1">
            Generate magic links for suppliers to view and manage fix reports
          </p>
        </div>
        <Button onClick={() => setShowCreateDialog(true)} data-testid="button-create-token">
          <Plus className="w-4 h-4 mr-1" />
          Create Token
        </Button>
      </div>
      
      {isLoading ? (
        <div className="flex justify-center py-12">
          <LoadingSpinner />
        </div>
      ) : tokens.length === 0 ? (
        <Card>
          <CardContent className="pt-6 text-center py-12">
            <Key className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="font-medium mb-2">No supplier tokens yet</h3>
            <p className="text-muted-foreground text-sm mb-4">
              Create a token to generate a magic link for your suppliers
            </p>
            <Button onClick={() => setShowCreateDialog(true)}>
              <Plus className="w-4 h-4 mr-1" />
              Create First Token
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {tokens.map(token => (
            <Card key={token.id} data-testid={`card-token-${token.id}`}>
              <CardContent className="pt-6">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-2">
                      <h3 className="font-medium">{token.name}</h3>
                      {token.isActive ? (
                        <Badge variant="outline" className="text-green-600 border-green-300">
                          Active
                        </Badge>
                      ) : (
                        <Badge variant="destructive">Expired</Badge>
                      )}
                    </div>
                    
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm text-muted-foreground">
                      <div className="flex items-center gap-1">
                        <Building2 className="w-4 h-4" />
                        <span className="truncate">{getBranchNames(token.allowedBranchIds)}</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <Clock className="w-4 h-4" />
                        Created {formatDistanceToNow(parseISO(token.createdAt), { addSuffix: true })}
                      </div>
                      {token.expiresAt && (
                        <div className="flex items-center gap-1">
                          <AlertCircle className="w-4 h-4" />
                          Expires {format(parseISO(token.expiresAt), "dd MMM yyyy")}
                        </div>
                      )}
                      {token.lastAccessedAt && (
                        <div className="flex items-center gap-1">
                          <ExternalLink className="w-4 h-4" />
                          Last used {formatDistanceToNow(parseISO(token.lastAccessedAt), { addSuffix: true })}
                        </div>
                      )}
                    </div>
                  </div>
                  
                  <Button 
                    variant="destructive" 
                    size="icon"
                    onClick={() => setTokenToDelete(token)}
                    data-testid={`button-revoke-token-${token.id}`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent data-testid="dialog-create-token">
          <DialogHeader>
            <DialogTitle>Create Supplier Token</DialogTitle>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div>
              <Label htmlFor="name">Supplier Name</Label>
              <Input
                id="name"
                placeholder="e.g., ABC Maintenance Company"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                data-testid="input-token-name"
              />
            </div>
            
            <div>
              <Label className="mb-2 block">Allowed Branches</Label>
              <div className="space-y-2 max-h-48 overflow-y-auto border rounded-md p-3">
                {branches.map(branch => (
                  <div key={branch.id} className="flex items-center gap-2">
                    <Checkbox
                      id={`branch-${branch.id}`}
                      checked={selectedBranches.includes(branch.id)}
                      onCheckedChange={() => toggleBranch(branch.id)}
                      data-testid={`checkbox-branch-${branch.id}`}
                    />
                    <label 
                      htmlFor={`branch-${branch.id}`}
                      className="text-sm cursor-pointer"
                    >
                      {branch.name}
                    </label>
                  </div>
                ))}
              </div>
              {selectedBranches.length === 0 && (
                <p className="text-xs text-muted-foreground mt-1">
                  Select at least one branch
                </p>
              )}
            </div>
            
            <div>
              <Label htmlFor="expires">Expires In (days, optional)</Label>
              <Input
                id="expires"
                type="number"
                placeholder="e.g., 30 (leave empty for no expiry)"
                value={expiresIn}
                onChange={(e) => setExpiresIn(e.target.value)}
                data-testid="input-token-expires"
              />
            </div>
          </div>
          
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => createTokenMutation.mutate()}
              disabled={!newName.trim() || selectedBranches.length === 0 || createTokenMutation.isPending}
              data-testid="button-confirm-create-token"
            >
              {createTokenMutation.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
              Create Token
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      
      <Dialog open={showSuccessDialog} onOpenChange={setShowSuccessDialog}>
        <DialogContent data-testid="dialog-token-created">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Check className="w-5 h-5 text-green-500" />
              Token Created Successfully
            </DialogTitle>
          </DialogHeader>
          
          {newTokenData && (
            <div className="space-y-4 py-4">
              <div className="bg-yellow-50 dark:bg-yellow-950 border border-yellow-200 dark:border-yellow-800 rounded-md p-3">
                <div className="flex items-start gap-2">
                  <AlertCircle className="w-5 h-5 text-yellow-600 flex-shrink-0 mt-0.5" />
                  <div className="text-sm">
                    <p className="font-medium text-yellow-800 dark:text-yellow-200">
                      Save this link now!
                    </p>
                    <p className="text-yellow-700 dark:text-yellow-300 mt-1">
                      The magic link can only be shown once and cannot be retrieved later.
                    </p>
                  </div>
                </div>
              </div>
              
              <div>
                <Label className="text-xs text-muted-foreground">Magic Link for {newTokenData.name}</Label>
                <div className="flex items-center gap-2 mt-1">
                  <Input
                    readOnly
                    value={newTokenData.magicLink}
                    className="font-mono text-xs"
                    data-testid="input-magic-link"
                  />
                  <Button 
                    size="icon" 
                    variant="outline"
                    onClick={() => copyToClipboard(newTokenData.magicLink)}
                    data-testid="button-copy-link"
                  >
                    {copied ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
                  </Button>
                </div>
              </div>
              
              <div className="text-sm text-muted-foreground">
                <p>Share this link with your supplier ({newTokenData.name}).</p>
                <p className="mt-1">
                  They will be able to view and manage fix reports for: {getBranchNames(newTokenData.allowedBranchIds)}
                </p>
              </div>
            </div>
          )}
          
          <DialogFooter>
            <Button onClick={() => setShowSuccessDialog(false)} data-testid="button-close-success">
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      
      <AlertDialog open={!!tokenToDelete} onOpenChange={(open) => !open && setTokenToDelete(null)}>
        <AlertDialogContent data-testid="dialog-revoke-token">
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke Supplier Token?</AlertDialogTitle>
            <AlertDialogDescription>
              This will immediately revoke access for "{tokenToDelete?.name}". 
              They will no longer be able to access the supplier portal.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => tokenToDelete && deleteTokenMutation.mutate(tokenToDelete.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-revoke"
            >
              {deleteTokenMutation.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
              Revoke Access
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
