import { ModelAdmin, deriveFormFields } from "../admin";
import { files } from "../../../shared/schema";

class FileAdmin extends ModelAdmin {
  name = "File";
  table = files;
  priority = 46;
  description = "Metadata record for files uploaded to object storage, tracking the storage key, MIME type, size, and source system.";

  listDisplay = [
    { key: "originalFilename", label: "Filename" },
    { key: "source" },
    { key: "mimeType", label: "MIME Type" },
    { key: "sizeBytes", label: "Size (bytes)", type: "number" as const },
    { key: "tenantId", label: "Tenant", relatedModel: "tenants", relatedLabelField: "name" },
    { key: "createdAt", type: "date" as const },
  ];

  searchFields = ["originalFilename", "source", "storageKey"];

  filters = [
    { key: "source", label: "Source", type: "select" as const, options: [] },
  ];

  defaultOrderBy = "createdAt";

  get formFields() {
    return deriveFormFields(this.table).map(f => {
      if (f.key === "tenantId") return { ...f, label: "Tenant", relatedModel: "tenants", relatedLabelField: "name" };
      return f;
    });
  }
}

export default new FileAdmin();
