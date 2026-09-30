import { useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Lock, Eye, EyeOff, Copy, Wifi, Monitor, Key, Building2, CreditCard, MoreHorizontal, Search, Filter, Check, ArrowLeft } from "lucide-react";
import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

interface AccessItem {
  id: string;
  title: string;
  category: string | null;
  username: string | null;
  branchIds: string[];
  visibilityLevel: string;
  status: string;
  notes: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

interface Branch {
  id: string;
  name: string;
}

const categoryIcons: Record<string, any> = {
  wifi: Wifi,
  systems: Monitor,
  door_lock: Key,
  vendor: Building2,
  banking: CreditCard,
  other: MoreHorizontal,
};

const categoryLabels: Record<string, string> = {
  wifi: "Wi-Fi",
  systems: "Systems",
  door_lock: "Door / Lock",
  vendor: "Vendor",
  banking: "Banking",
  other: "Other",
};

export default function AccessPage() {
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [branchFilter, setBranchFilter] = useState<string>("all");
  const [selectedItem, setSelectedItem] = useState<AccessItem | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [revealedPassword, setRevealedPassword] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const { data: accessItems = [], isLoading } = useQuery<AccessItem[]>({
    queryKey: ["/api/access"],
  });

  const { data: branches = [] } = useQuery<Branch[]>({
    queryKey: ["/api/branches"],
  });

  const { data: itemDetail, isLoading: isLoadingDetail } = useQuery<AccessItem>({
    queryKey: ["/api/access", selectedItem?.id],
    enabled: !!selectedItem?.id,
  });

  const revealMutation = useMutation({
    mutationFn: async (id: string): Promise<string> => {
      const response = await apiRequest("POST", `/api/access/${id}/reveal`);
      const result = await response.json();
      return result.password;
    },
  });

  const filteredItems = accessItems.filter(item => {
    const matchesSearch = item.title.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCategory = categoryFilter === "all" || item.category === categoryFilter;
    const matchesBranch = branchFilter === "all" || item.branchIds.length === 0 || item.branchIds.includes(branchFilter);
    return matchesSearch && matchesCategory && matchesBranch;
  });

  const handleItemClick = (item: AccessItem) => {
    selectedIdRef.current = item.id;
    setSelectedItem(item);
    setShowPassword(false);
    setRevealedPassword(null);
    setCopied(false);
  };

  const handleShowPassword = async () => {
    if (showPassword) {
      setShowPassword(false);
      setRevealedPassword(null);
      return;
    }
    if (!selectedItem) return;
    try {
      const password = await revealMutation.mutateAsync(selectedItem.id);
      if (selectedIdRef.current !== selectedItem.id) return;
      setRevealedPassword(password);
      setShowPassword(true);
    } catch {
      toast({ title: "Unable to show credential", variant: "destructive" });
    }
  };

  const handleCopyPassword = async () => {
    if (selectedItem) {
      try {
        const password = revealedPassword ?? await revealMutation.mutateAsync(selectedItem.id);
        if (selectedIdRef.current !== selectedItem.id) return;
        await navigator.clipboard.writeText(password);
      } catch {
        toast({ title: "Unable to copy credential", variant: "destructive" });
        return;
      }
      setCopied(true);
      toast({
        title: "Copied",
        description: "Password copied to clipboard",
      });
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleCopyUsername = async () => {
    if (itemDetail?.username) {
      await navigator.clipboard.writeText(itemDetail.username);
      toast({
        title: "Copied",
        description: "Username copied to clipboard",
      });
    }
  };

  const branchMap = new Map(branches.map(b => [b.id, b.name]));

  return (
    <div className="min-h-screen bg-background p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
      <div className="flex items-center gap-4 mb-6">
        <Link href="/">
          <Button variant="ghost" size="icon" data-testid="button-back-home">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold">Vault</h1>
          <p className="text-muted-foreground">Shared passwords, codes, and access credentials</p>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by title..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
            data-testid="input-access-search"
          />
        </div>
        <Select value={categoryFilter} onValueChange={setCategoryFilter}>
          <SelectTrigger className="w-full sm:w-40" data-testid="select-category-filter">
            <Filter className="h-4 w-4 mr-2" />
            <SelectValue placeholder="Category" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Categories</SelectItem>
            <SelectItem value="wifi">Wi-Fi</SelectItem>
            <SelectItem value="systems">Systems</SelectItem>
            <SelectItem value="door_lock">Door / Lock</SelectItem>
            <SelectItem value="vendor">Vendor</SelectItem>
            <SelectItem value="banking">Banking</SelectItem>
            <SelectItem value="other">Other</SelectItem>
          </SelectContent>
        </Select>
        {branches.length > 1 && (
          <Select value={branchFilter} onValueChange={setBranchFilter}>
            <SelectTrigger className="w-full sm:w-40" data-testid="select-branch-filter">
              <SelectValue placeholder="Branch" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Branches</SelectItem>
              {branches.map(branch => (
                <SelectItem key={branch.id} value={branch.id}>{branch.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-muted-foreground">Loading...</div>
      ) : filteredItems.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <Lock className="h-12 w-12 mx-auto mb-4 opacity-20" />
            <p>No access items found</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filteredItems.map(item => {
            const Icon = categoryIcons[item.category || "other"] || MoreHorizontal;
            return (
              <Card 
                key={item.id}
                className="cursor-pointer hover-elevate"
                onClick={() => handleItemClick(item)}
                data-testid={`card-access-${item.id}`}
              >
                <CardContent className="py-4 flex items-center gap-4">
                  <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center flex-shrink-0">
                    <Icon className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{item.title}</div>
                    <div className="flex items-center gap-2 flex-wrap mt-1">
                      {item.category && (
                        <Badge variant="secondary" className="text-xs">
                          {categoryLabels[item.category] || item.category}
                        </Badge>
                      )}
                      {item.branchIds.map(bid => (
                        <Badge key={bid} variant="outline" className="text-xs">
                          {branchMap.get(bid) || bid}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  <Lock className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={!!selectedItem} onOpenChange={(open) => { if (!open) { selectedIdRef.current = null; setSelectedItem(null); setRevealedPassword(null); setShowPassword(false); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Lock className="h-5 w-5" />
              {selectedItem?.title}
            </DialogTitle>
          </DialogHeader>
          
          {isLoadingDetail ? (
            <div className="py-8 text-center text-muted-foreground">Loading...</div>
          ) : itemDetail ? (
            <div className="space-y-4">
              {itemDetail.category && (
                <div>
                  <div className="text-sm text-muted-foreground mb-1">Category</div>
                  <Badge variant="secondary">
                    {categoryLabels[itemDetail.category] || itemDetail.category}
                  </Badge>
                </div>
              )}

              {itemDetail.username && (
                <div>
                  <div className="text-sm text-muted-foreground mb-1">Username</div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 bg-muted px-3 py-2 rounded text-sm font-mono">
                      {itemDetail.username}
                    </code>
                    <Button 
                      size="icon" 
                      variant="ghost"
                      onClick={handleCopyUsername}
                      data-testid="button-copy-username"
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}

              <div>
                <div className="text-sm text-muted-foreground mb-1">Password / Code</div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 bg-muted px-3 py-2 rounded text-sm font-mono">
                    {showPassword ? revealedPassword : "••••••••••••"}
                  </code>
                  <Button 
                    size="icon" 
                    variant="ghost"
                    onClick={handleShowPassword}
                    disabled={revealMutation.isPending}
                    data-testid="button-toggle-password"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                  <Button 
                    size="icon" 
                    variant="ghost"
                    onClick={handleCopyPassword}
                    disabled={revealMutation.isPending}
                    data-testid="button-copy-password"
                  >
                    {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
              </div>

              {itemDetail.notes && (
                <div>
                  <div className="text-sm text-muted-foreground mb-1">Notes</div>
                  <div className="text-sm whitespace-pre-wrap bg-muted p-3 rounded">
                    {itemDetail.notes}
                  </div>
                </div>
              )}

              {itemDetail.branchIds && itemDetail.branchIds.length > 0 && (
                <div>
                  <div className="text-sm text-muted-foreground mb-1">Branches</div>
                  <div className="flex flex-wrap gap-1">
                    {itemDetail.branchIds.map(bid => (
                      <Badge key={bid} variant="outline">
                        {branchMap.get(bid) || bid}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              <div className="text-xs text-muted-foreground pt-2 border-t">
                Last updated: {new Date(itemDetail.updatedAt).toLocaleDateString()}
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
      </div>
    </div>
  );
}
