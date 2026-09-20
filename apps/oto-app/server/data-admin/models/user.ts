import { ModelAdmin } from "../admin";
import { users, userRoles } from "../../../shared/schema";

import { hashPassword } from "../../auth";

class UserAdmin extends ModelAdmin {
  name = "User";
  description = "System login accounts with RBAC roles (global_admin through staff), phone OTP support, and optional link to an employee record.";
  priority = 44;
  table = users;

  listDisplay = [
    { key: "fullName", label: "Name" },
    { key: "email" },
    { key: "role", type: "enum" as const },
    { key: "isActive", type: "boolean" as const, label: "Active" },
    { key: "operatorId", label: "Operator", relatedModel: "operators", relatedLabelField: "name" },
    { key: "createdAt", type: "date" as const },
  ];

  searchFields = ["fullName", "email"];

  filters = [
    {
      key: "role",
      label: "Role",
      type: "select" as const,
      options: userRoles.map((r) => ({
        label: r.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        value: r,
      })),
    },
    {
      key: "isActive",
      label: "Active",
      type: "boolean" as const,
    },
  ];

  protected formFieldOverrides = [
    { key: "fullName", label: "Full Name", required: true },
    { key: "preferredName", label: "Preferred Name" },
    { key: "email", required: true, inputType: "email" as const },
    { key: "username", label: "Username" },
    // Password shown only on create (handled in create override)
    { key: "password", required: true, inputType: "password" as const, label: "Password" },
    {
      key: "role",
      type: "enum" as const,
      required: true,
      defaultValue: "staff",
      options: userRoles.map((r) => ({
        label: r.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        value: r,
      })),
    },
    { key: "isActive", type: "boolean" as const, label: "Active", defaultValue: true },
    { key: "mustChangePassword", type: "boolean" as const, label: "Must Change Password", defaultValue: true },
    { key: "operatorId", label: "Operator", relatedModel: "operators", relatedLabelField: "name" },
  ];

  defaultOrderBy = "fullName";

  /** Hash password before inserting */
  async create(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    const mutable = { ...data };
    if (mutable.password && typeof mutable.password === "string") {
      mutable.password = await hashPassword(mutable.password);
    }
    return super.create(mutable);
  }

  /** Hash password on update only if a new one was supplied */
  async update(id: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    const mutable = { ...data };
    if (mutable.password && typeof mutable.password === "string" && mutable.password.trim()) {
      mutable.password = await hashPassword(mutable.password);
    } else {
      delete mutable.password; // don't overwrite with empty string
    }
    return super.update(id, mutable);
  }
}

export default new UserAdmin();
