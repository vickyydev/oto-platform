import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { StudioLayout } from "@/components/layout/studio-layout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Plus, Pencil, Trash2, GripVertical } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Department } from "@shared/schema";

const departmentFormSchema = z.object({
  name: z.string().min(1, "Name is required"),
  sortOrder: z.number().default(0),
});

type DepartmentFormValues = z.infer<typeof departmentFormSchema>;

export default function StudioDepartmentsPage() {
  const { toast } = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingDepartment, setEditingDepartment] = useState<Department | null>(null);

  const { data: departments = [], isLoading } = useQuery<Department[]>({
    queryKey: ["/api/departments"],
  });

  const form = useForm<DepartmentFormValues>({
    resolver: zodResolver(departmentFormSchema),
    defaultValues: {
      name: "",
      sortOrder: 0,
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: DepartmentFormValues) => {
      const res = await apiRequest("POST", "/api/admin/departments", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/departments"] });
      toast({ title: "Department created" });
      setDialogOpen(false);
      form.reset();
    },
    onError: () => {
      toast({ title: "Failed to create department", variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<DepartmentFormValues> }) => {
      const res = await apiRequest("PATCH", `/api/admin/departments/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/departments"] });
      toast({ title: "Department updated" });
      setDialogOpen(false);
      setEditingDepartment(null);
      form.reset();
    },
    onError: () => {
      toast({ title: "Failed to update department", variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/admin/departments/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/departments"] });
      toast({ title: "Department deleted" });
    },
    onError: () => {
      toast({ title: "Failed to delete department. It may have tasks assigned.", variant: "destructive" });
    },
  });

  const openNewDialog = () => {
    setEditingDepartment(null);
    form.reset({
      name: "",
      sortOrder: departments.length,
    });
    setDialogOpen(true);
  };

  const openEditDialog = (dept: Department) => {
    setEditingDepartment(dept);
    form.reset({
      name: dept.name,
      sortOrder: dept.sortOrder,
    });
    setDialogOpen(true);
  };

  const onSubmit = (data: DepartmentFormValues) => {
    if (editingDepartment) {
      updateMutation.mutate({ id: editingDepartment.id, data });
    } else {
      createMutation.mutate(data);
    }
  };

  const sortedDepartments = [...departments].sort((a, b) => a.sortOrder - b.sortOrder);

  return (
    <StudioLayout>
      <div className="p-4 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">Departments</h1>
            <p className="text-sm text-muted-foreground">Manage staff departments</p>
          </div>
          <Button onClick={openNewDialog} data-testid="button-add-department">
            <Plus className="h-4 w-4 mr-2" />
            Add
          </Button>
        </div>

        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map(i => (
              <Card key={i} className="p-4 animate-pulse">
                <div className="h-5 bg-muted rounded w-1/3" />
              </Card>
            ))}
          </div>
        ) : sortedDepartments.length === 0 ? (
          <Card className="p-8 text-center text-muted-foreground">
            <p>No departments yet. Click "Add" to create one.</p>
          </Card>
        ) : (
          <div className="space-y-2">
            {sortedDepartments.map((dept) => (
              <Card key={dept.id} className="p-3" data-testid={`card-department-${dept.id}`}>
                <div className="flex items-center gap-3">
                  <GripVertical className="h-4 w-4 text-muted-foreground" />
                  <span className="flex-1 font-medium">{dept.name}</span>
                  <div className="flex items-center gap-1">
                    <Button 
                      size="icon" 
                      variant="ghost" 
                      onClick={() => openEditDialog(dept)}
                      data-testid={`button-edit-department-${dept.id}`}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button 
                      size="icon" 
                      variant="ghost" 
                      onClick={() => deleteMutation.mutate(dept.id)}
                      className="text-destructive"
                      data-testid={`button-delete-department-${dept.id}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{editingDepartment ? "Edit Department" : "Add New Department"}</DialogTitle>
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
                      <Input {...field} placeholder="Department name" data-testid="input-department-name" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="flex justify-end gap-2 pt-4">
                <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                  Cancel
                </Button>
                <Button 
                  type="submit" 
                  disabled={createMutation.isPending || updateMutation.isPending}
                  data-testid="button-save-department"
                >
                  {editingDepartment ? "Update" : "Create"}
                </Button>
              </div>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </StudioLayout>
  );
}
