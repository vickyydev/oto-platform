import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { StudioLayout } from "@/components/layout/studio-layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Switch } from "@/components/ui/switch";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Plus, Pencil, Trash2, Gift, Image, Calendar } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { ObjectUploader } from "@/components/ObjectUploader";
import type { VoucherTemplate } from "@shared/schema";
import { format } from "date-fns";

const voucherFormSchema = z.object({
  name: z.string().min(1, "Name is required"),
  description: z.string().optional(),
  imageUrl: z.string().min(1, "Image is required"),
  maxUses: z.number().min(1, "Must allow at least 1 use"),
  validFrom: z.string().optional(),
  validTo: z.string().optional(),
  isActive: z.boolean().default(true),
});

type VoucherFormValues = z.infer<typeof voucherFormSchema>;

export default function StudioVouchersPage() {
  const { toast } = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<VoucherTemplate | null>(null);

  const { data: templates = [], isLoading } = useQuery<VoucherTemplate[]>({
    queryKey: ["/api/studio/voucher-templates"],
  });

  const form = useForm<VoucherFormValues>({
    resolver: zodResolver(voucherFormSchema),
    defaultValues: {
      name: "",
      description: "",
      imageUrl: "",
      maxUses: 1,
      validFrom: "",
      validTo: "",
      isActive: true,
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: VoucherFormValues) => {
      const res = await apiRequest("POST", "/api/studio/voucher-templates", {
        name: data.name,
        description: data.description || null,
        imageUrl: data.imageUrl,
        maxUses: data.maxUses,
        validFrom: data.validFrom ? new Date(data.validFrom).toISOString() : null,
        validTo: data.validTo ? new Date(data.validTo).toISOString() : null,
        isActive: data.isActive,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/studio/voucher-templates"] });
      toast({ title: "Voucher template created" });
      setDialogOpen(false);
      form.reset();
    },
    onError: () => {
      toast({ title: "Failed to create template", variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<VoucherFormValues> }) => {
      const res = await apiRequest("PATCH", `/api/studio/voucher-templates/${id}`, {
        name: data.name,
        description: data.description || null,
        imageUrl: data.imageUrl,
        maxUses: data.maxUses,
        validFrom: data.validFrom ? new Date(data.validFrom).toISOString() : null,
        validTo: data.validTo ? new Date(data.validTo).toISOString() : null,
        isActive: data.isActive,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/studio/voucher-templates"] });
      toast({ title: "Template updated" });
      setDialogOpen(false);
      setEditingTemplate(null);
      form.reset();
    },
    onError: () => {
      toast({ title: "Failed to update template", variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/studio/voucher-templates/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/studio/voucher-templates"] });
      toast({ title: "Template deleted" });
    },
    onError: () => {
      toast({ title: "Failed to delete template", variant: "destructive" });
    },
  });

  const openCreateDialog = () => {
    setEditingTemplate(null);
    form.reset({
      name: "",
      description: "",
      imageUrl: "",
      maxUses: 1,
      validFrom: "",
      validTo: "",
      isActive: true,
    });
    setDialogOpen(true);
  };

  const openEditDialog = (template: VoucherTemplate) => {
    setEditingTemplate(template);
    form.reset({
      name: template.name,
      description: template.description || "",
      imageUrl: template.imageUrl,
      maxUses: template.maxUses,
      validFrom: template.validFrom ? format(new Date(template.validFrom), "yyyy-MM-dd") : "",
      validTo: template.validTo ? format(new Date(template.validTo), "yyyy-MM-dd") : "",
      isActive: template.isActive,
    });
    setDialogOpen(true);
  };

  const onSubmit = (data: VoucherFormValues) => {
    if (editingTemplate) {
      updateMutation.mutate({ id: editingTemplate.id, data });
    } else {
      createMutation.mutate(data);
    }
  };

  async function handleGetUploadParameters(file: { name: string; type?: string | null }) {
    const response = await fetch("/api/object-storage/presign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        filename: file.name,
        contentType: file.type || "application/octet-stream",
        isPublic: true,
      }),
    });
    const data = await response.json();
    return {
      method: "PUT" as const,
      url: data.uploadUrl as string,
      headers: { "Content-Type": file.type || "application/octet-stream" },
    };
  }

  return (
    <StudioLayout>
      <div className="p-4 max-w-lg mx-auto">
        <div className="flex items-center justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl font-bold text-violet-900 dark:text-violet-100">Voucher Templates</h1>
            <p className="text-sm text-muted-foreground">Create reward vouchers to assign to staff</p>
          </div>
          <Button onClick={openCreateDialog} data-testid="button-create-voucher">
            <Plus className="h-4 w-4 mr-2" />
            Create
          </Button>
        </div>

        {isLoading ? (
          <div className="text-center py-8 text-muted-foreground">Loading...</div>
        ) : templates.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-muted-foreground">
              <Gift className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No voucher templates yet</p>
              <p className="text-sm">Create your first template to start rewarding staff</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {templates.map((template) => (
              <Card key={template.id} className="overflow-visible" data-testid={`card-voucher-${template.id}`}>
                <CardContent className="p-4">
                  <div className="flex gap-4">
                    {template.imageUrl ? (
                      <img
                        src={template.imageUrl}
                        alt={template.name}
                        className="w-16 h-16 rounded-md object-cover flex-shrink-0"
                      />
                    ) : (
                      <div className="w-16 h-16 rounded-md bg-muted flex items-center justify-center flex-shrink-0">
                        <Gift className="h-6 w-6 text-muted-foreground" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <h3 className="font-semibold truncate">{template.name}</h3>
                          {template.description && (
                            <p className="text-sm text-muted-foreground line-clamp-2">{template.description}</p>
                          )}
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => openEditDialog(template)}
                            data-testid={`button-edit-voucher-${template.id}`}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => deleteMutation.mutate(template.id)}
                            data-testid={`button-delete-voucher-${template.id}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 mt-2">
                        <Badge variant={template.isActive ? "default" : "secondary"}>
                          {template.isActive ? "Active" : "Inactive"}
                        </Badge>
                        <Badge variant="outline">{template.maxUses} use{template.maxUses > 1 ? "s" : ""}</Badge>
                        {template.validTo && (
                          <Badge variant="outline" className="gap-1">
                            <Calendar className="h-3 w-3" />
                            Until {format(new Date(template.validTo), "MMM d")}
                          </Badge>
                        )}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingTemplate ? "Edit Template" : "Create Voucher Template"}</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input placeholder="Free Coffee" {...field} data-testid="input-voucher-name" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Description (optional)</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="One free coffee at the staff cafe"
                        {...field}
                        data-testid="input-voucher-description"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="imageUrl"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Image</FormLabel>
                    <FormControl>
                      <div className="space-y-2">
                        {field.value ? (
                          <div className="relative w-full h-32 rounded-md overflow-hidden bg-muted">
                            <img
                              src={field.value}
                              alt="Voucher"
                              className="w-full h-full object-cover"
                            />
                            <Button
                              type="button"
                              size="icon"
                              variant="secondary"
                              className="absolute top-2 right-2"
                              onClick={() => field.onChange("")}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        ) : (
                          <ObjectUploader
                            maxNumberOfFiles={1}
                            onGetUploadParameters={handleGetUploadParameters}
                            onComplete={async (result) => {
                              const uploaded = result.successful?.[0];
                              if (uploaded) {
                                const response = await fetch("/api/object-storage/finalize", {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json" },
                                  credentials: "include",
                                  body: JSON.stringify({
                                    filename: uploaded.name,
                                    isPublic: true,
                                  }),
                                });
                                const data = await response.json();
                                if (data.publicUrl) {
                                  field.onChange(data.publicUrl);
                                }
                              }
                            }}
                            buttonClassName="w-full"
                          >
                            <Image className="h-4 w-4 mr-2" />
                            Upload Image
                          </ObjectUploader>
                        )}
                      </div>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="maxUses"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Max Uses per Voucher</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={1}
                        {...field}
                        onChange={(e) => field.onChange(parseInt(e.target.value) || 1)}
                        data-testid="input-voucher-max-uses"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="validFrom"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Valid From</FormLabel>
                      <FormControl>
                        <Input type="date" {...field} data-testid="input-voucher-valid-from" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="validTo"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Valid To</FormLabel>
                      <FormControl>
                        <Input type="date" {...field} data-testid="input-voucher-valid-to" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="isActive"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-md border p-3">
                    <FormLabel className="cursor-pointer">Active</FormLabel>
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                  </FormItem>
                )}
              />

              <Button
                type="submit"
                className="w-full"
                disabled={createMutation.isPending || updateMutation.isPending}
                data-testid="button-save-voucher"
              >
                {createMutation.isPending || updateMutation.isPending
                  ? "Saving..."
                  : editingTemplate
                  ? "Save Changes"
                  : "Create Template"}
              </Button>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </StudioLayout>
  );
}
