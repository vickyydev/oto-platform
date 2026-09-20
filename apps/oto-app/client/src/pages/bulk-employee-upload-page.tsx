import { useState, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Upload,
  Download,
  Check,
  X,
  AlertTriangle,
  FileSpreadsheet,
  ArrowRight,
  RefreshCw,
  UserPlus,
  UserCheck,
  Minus,
} from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

interface PreviewRow {
  rowNumber: number;
  data: Record<string, any>;
  branchId: string | null;
  matchedEmployeeId: string | null;
  matchedEmployeeName: string | null;
  isNew: boolean;
  changes: string[];
  currentData: Record<string, any>;
  error: string | null;
  status: "update" | "new" | "no_change" | "error";
}

interface PreviewResponse {
  previewRows: PreviewRow[];
  stats: {
    total: number;
    updates: number;
    newRecords: number;
    noChange: number;
    errors: number;
  };
  mappedColumns: string[];
}

interface ApplyResult {
  rowNumber: number;
  status: string;
  message: string;
  employeeId?: string;
}

interface ApplyResponse {
  results: ApplyResult[];
  stats: {
    total: number;
    created: number;
    updated: number;
    skipped: number;
    errors: number;
  };
}

export default function BulkEmployeeUploadPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewData, setPreviewData] = useState<PreviewResponse | null>(null);
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [applyResults, setApplyResults] = useState<ApplyResponse | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [applyProgress, setApplyProgress] = useState({ current: 0, total: 0 });

  const canEdit = user?.role !== "staff";

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setSelectedFile(file);
      setPreviewData(null);
      setApplyResults(null);
      setSelectedRows(new Set());
    }
  };

  const handleUploadPreview = async () => {
    if (!selectedFile) return;
    
    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", selectedFile);
      
      const response = await fetch("/api/employees/bulk-upload-preview", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || "Failed to process file");
      }
      
      const data: PreviewResponse = await response.json();
      setPreviewData(data);
      
      // Auto-select all valid rows
      const validRowNumbers = data.previewRows
        .filter(r => r.status !== "error" && r.status !== "no_change")
        .map(r => r.rowNumber);
      setSelectedRows(new Set(validRowNumbers));
      
      toast({
        title: "File processed",
        description: `Found ${data.stats.total} records: ${data.stats.updates} updates, ${data.stats.newRecords} new, ${data.stats.errors} errors`,
      });
    } catch (error: any) {
      toast({
        title: "Upload failed",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsUploading(false);
    }
  };

  const handleApplyChanges = async () => {
    if (!previewData || selectedRows.size === 0) return;
    
    const rowsToApply = previewData.previewRows.filter(r => selectedRows.has(r.rowNumber));
    
    setIsApplying(true);
    setApplyProgress({ current: 0, total: rowsToApply.length });
    
    try {
      const response = await apiRequest("POST", "/api/employees/bulk-update", { rows: rowsToApply });
      const data: ApplyResponse = await response.json();
      
      setApplyResults(data);
      setApplyProgress({ current: data.stats.total, total: data.stats.total });
      
      queryClient.invalidateQueries({ queryKey: ["/api/employees"] });
      queryClient.invalidateQueries({ queryKey: ["/api/departments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/roles"] });
      
      toast({
        title: "Bulk update complete",
        description: `${data.stats.created} created, ${data.stats.updated} updated, ${data.stats.errors} errors`,
      });
    } catch (error: any) {
      toast({
        title: "Bulk update failed",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsApplying(false);
    }
  };

  const handleDownloadTemplate = () => {
    window.open("/api/employees/bulk-template", "_blank");
  };

  const handleReset = () => {
    setSelectedFile(null);
    setPreviewData(null);
    setApplyResults(null);
    setSelectedRows(new Set());
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const toggleRowSelection = (rowNumber: number) => {
    const newSelected = new Set(selectedRows);
    if (newSelected.has(rowNumber)) {
      newSelected.delete(rowNumber);
    } else {
      newSelected.add(rowNumber);
    }
    setSelectedRows(newSelected);
  };

  const selectableRows = previewData?.previewRows.filter(r => r.status !== "error" && r.status !== "no_change") || [];

  const toggleSelectAll = () => {
    if (selectedRows.size === selectableRows.length) {
      setSelectedRows(new Set());
    } else {
      setSelectedRows(new Set(selectableRows.map(r => r.rowNumber)));
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "update":
        return <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200"><UserCheck className="h-3 w-3 mr-1" /> Update</Badge>;
      case "new":
        return <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200"><UserPlus className="h-3 w-3 mr-1" /> New</Badge>;
      case "no_change":
        return <Badge variant="outline" className="bg-gray-50 text-gray-500 border-gray-200"><Minus className="h-3 w-3 mr-1" /> No Change</Badge>;
      case "error":
        return <Badge variant="destructive"><AlertTriangle className="h-3 w-3 mr-1" /> Error</Badge>;
      case "created":
        return <Badge className="bg-green-600"><Check className="h-3 w-3 mr-1" /> Created</Badge>;
      case "updated":
        return <Badge className="bg-blue-600"><Check className="h-3 w-3 mr-1" /> Updated</Badge>;
      case "skipped":
        return <Badge variant="outline"><Minus className="h-3 w-3 mr-1" /> Skipped</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  if (!canEdit) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            You don't have permission to perform bulk employee updates. Please contact an administrator.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-medium" data-testid="text-bulk-upload-title">Bulk Employee Upload</h1>
        <p className="text-muted-foreground">Import or update employee records from an Excel spreadsheet</p>
      </div>

      {/* Step 1: Upload File */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5" />
            Step 1: Select Excel File
          </CardTitle>
          <CardDescription>
            Upload an Excel file (.xlsx) with employee data. Download the template for the correct column format.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-4 items-center">
            <Button variant="outline" onClick={handleDownloadTemplate} data-testid="button-download-template">
              <Download className="h-4 w-4 mr-2" />
              Download Template
            </Button>
            
            <div className="flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls"
                onChange={handleFileSelect}
                className="hidden"
                id="excel-upload"
                data-testid="input-file-upload"
              />
              <Button asChild variant="outline">
                <label htmlFor="excel-upload" className="cursor-pointer">
                  <Upload className="h-4 w-4 mr-2" />
                  Select File
                </label>
              </Button>
              
              {selectedFile && (
                <span className="text-sm text-muted-foreground">{selectedFile.name}</span>
              )}
            </div>
            
            {selectedFile && !previewData && (
              <Button onClick={handleUploadPreview} disabled={isUploading} data-testid="button-process-file">
                {isUploading ? (
                  <>
                    <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                    Processing...
                  </>
                ) : (
                  <>
                    <ArrowRight className="h-4 w-4 mr-2" />
                    Process File
                  </>
                )}
              </Button>
            )}
            
            {(previewData || applyResults) && (
              <Button variant="ghost" onClick={handleReset} data-testid="button-reset">
                <RefreshCw className="h-4 w-4 mr-2" />
                Start Over
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Step 2: Preview Changes */}
      {previewData && !applyResults && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Check className="h-5 w-5" />
              Step 2: Review Changes
            </CardTitle>
            <CardDescription>
              Review the changes before applying. Select the rows you want to import or update.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Stats summary */}
            <div className="flex flex-wrap gap-4">
              <div className="text-sm">
                <span className="text-muted-foreground">Total: </span>
                <span className="font-medium">{previewData.stats.total}</span>
              </div>
              <div className="text-sm">
                <span className="text-green-600">New: </span>
                <span className="font-medium">{previewData.stats.newRecords}</span>
              </div>
              <div className="text-sm">
                <span className="text-blue-600">Updates: </span>
                <span className="font-medium">{previewData.stats.updates}</span>
              </div>
              <div className="text-sm">
                <span className="text-gray-500">No Change: </span>
                <span className="font-medium">{previewData.stats.noChange}</span>
              </div>
              <div className="text-sm">
                <span className="text-red-600">Errors: </span>
                <span className="font-medium">{previewData.stats.errors}</span>
              </div>
            </div>

            <ScrollArea className="h-[400px] border rounded-md">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12">
                      <Checkbox
                        checked={selectableRows.length > 0 && selectedRows.size === selectableRows.length}
                        onCheckedChange={toggleSelectAll}
                        aria-label="Select all"
                        data-testid="checkbox-select-all-preview"
                      />
                    </TableHead>
                    <TableHead className="w-16">Row</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Branch</TableHead>
                    <TableHead>Position</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Changes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {previewData.previewRows.map((row) => (
                    <TableRow 
                      key={row.rowNumber} 
                      className={row.status === "error" ? "bg-red-50 dark:bg-red-950/20" : ""}
                      data-testid={`row-preview-${row.rowNumber}`}
                    >
                      <TableCell>
                        <Checkbox
                          checked={selectedRows.has(row.rowNumber)}
                          onCheckedChange={() => toggleRowSelection(row.rowNumber)}
                          disabled={row.status === "error" || row.status === "no_change"}
                          aria-label={`Select row ${row.rowNumber}`}
                          data-testid={`checkbox-row-${row.rowNumber}`}
                        />
                      </TableCell>
                      <TableCell className="font-mono text-sm">{row.rowNumber}</TableCell>
                      <TableCell>
                        <div>
                          <p className="font-medium">{row.data.fullName || "—"}</p>
                          {row.matchedEmployeeName && row.matchedEmployeeName !== row.data.fullName && (
                            <p className="text-xs text-muted-foreground">Matched: {row.matchedEmployeeName}</p>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">{row.data.email || "—"}</TableCell>
                      <TableCell className="text-sm">{row.data.branchName || "—"}</TableCell>
                      <TableCell className="text-sm">{row.data.position || "—"}</TableCell>
                      <TableCell>{getStatusBadge(row.status)}</TableCell>
                      <TableCell>
                        {row.error ? (
                          <span className="text-sm text-red-600">{row.error}</span>
                        ) : row.changes.length > 0 ? (
                          <span className="text-sm text-muted-foreground">{row.changes.join(", ")}</span>
                        ) : row.isNew ? (
                          <span className="text-sm text-green-600">Will create new employee</span>
                        ) : (
                          <span className="text-sm text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>

            <div className="flex items-center justify-between">
              <div className="text-sm text-muted-foreground">
                {selectedRows.size} of {selectableRows.length} rows selected
              </div>
              <Button 
                onClick={handleApplyChanges} 
                disabled={selectedRows.size === 0 || isApplying}
                data-testid="button-apply-changes"
              >
                {isApplying ? (
                  <>
                    <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                    Applying...
                  </>
                ) : (
                  <>
                    <Check className="h-4 w-4 mr-2" />
                    Apply {selectedRows.size} Changes
                  </>
                )}
              </Button>
            </div>

            {isApplying && (
              <div className="space-y-2">
                <Progress value={(applyProgress.current / applyProgress.total) * 100} />
                <p className="text-sm text-muted-foreground text-center">
                  Processing {applyProgress.current} of {applyProgress.total}...
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Step 3: Results */}
      {applyResults && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Check className="h-5 w-5 text-green-600" />
              Import Complete
            </CardTitle>
            <CardDescription>
              Summary of the bulk import operation
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Results summary */}
            <div className="flex flex-wrap gap-4 p-4 bg-muted rounded-lg">
              <div className="text-center">
                <p className="text-2xl font-bold text-green-600">{applyResults.stats.created}</p>
                <p className="text-sm text-muted-foreground">Created</p>
              </div>
              <div className="text-center">
                <p className="text-2xl font-bold text-blue-600">{applyResults.stats.updated}</p>
                <p className="text-sm text-muted-foreground">Updated</p>
              </div>
              <div className="text-center">
                <p className="text-2xl font-bold text-gray-500">{applyResults.stats.skipped}</p>
                <p className="text-sm text-muted-foreground">Skipped</p>
              </div>
              <div className="text-center">
                <p className="text-2xl font-bold text-red-600">{applyResults.stats.errors}</p>
                <p className="text-sm text-muted-foreground">Errors</p>
              </div>
            </div>

            {applyResults.stats.errors > 0 && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  Some rows could not be processed. Check the details below for error messages.
                </AlertDescription>
              </Alert>
            )}

            <ScrollArea className="h-[300px] border rounded-md">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-16">Row</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Message</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {applyResults.results.map((result) => (
                    <TableRow 
                      key={result.rowNumber}
                      className={result.status === "error" ? "bg-red-50 dark:bg-red-950/20" : ""}
                      data-testid={`row-result-${result.rowNumber}`}
                    >
                      <TableCell className="font-mono text-sm">{result.rowNumber}</TableCell>
                      <TableCell>{getStatusBadge(result.status)}</TableCell>
                      <TableCell className="text-sm">{result.message}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
