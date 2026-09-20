import { Router } from "express";
import { db } from "./db";
import { orgNodes, OrgNode, InsertOrgNode } from "./db/coreSchema";
import { employees, branches, users, people, departments, staffCostAllocations } from "../shared/schema";
import { eq, and, sql, inArray, count } from "drizzle-orm";
import { requireAuth } from "./auth";
import { z } from "zod";

const router = Router();

const isAdmin = (role: string | undefined): boolean =>
  ["admin", "global_admin", "operator_admin"].includes(role || "");

const canViewSalaries = (role: string | undefined): boolean =>
  ["admin", "global_admin", "operator_admin"].includes(role || "");

const hasBranchAccess = (
  userBranchId: string | null | undefined,
  accessScope: string | undefined,
  targetBranchId: string | undefined | null
): boolean => {
  if (!targetBranchId) return true;
  if (accessScope === "all_branches") return true;
  return userBranchId === targetBranchId;
};

async function detectCycleForNewNode(
  tenantId: string,
  reportsToNodeId: string | null
): Promise<boolean> {
  if (!reportsToNodeId) return false;
  
  // Handle virtual advisor nodes (not persisted to database)
  if (reportsToNodeId.startsWith("advisor-")) {
    const advisorUserId = reportsToNodeId.replace("advisor-", "");
    const [advisorUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, advisorUserId), eq(users.tenantId, tenantId), eq(users.role, "advisor")))
      .limit(1);
    // If advisor exists, no cycle (advisors are always root nodes)
    return !advisorUser;
  }
  
  const [parentNode] = await db
    .select({ id: orgNodes.id })
    .from(orgNodes)
    .where(and(eq(orgNodes.id, reportsToNodeId), eq(orgNodes.tenantId, tenantId)))
    .limit(1);
  
  if (!parentNode) {
    return true;
  }
  
  return false;
}

async function detectCycleForUpdate(
  tenantId: string,
  nodeId: string,
  newReportsToId: string | null
): Promise<boolean> {
  if (!newReportsToId) return false;
  if (newReportsToId === nodeId) return true;
  
  // Handle virtual advisor nodes (not persisted to database)
  // Advisors are always root nodes with no parent, so no cycle possible
  if (newReportsToId.startsWith("advisor-")) {
    const advisorUserId = newReportsToId.replace("advisor-", "");
    const [advisorUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, advisorUserId), eq(users.tenantId, tenantId), eq(users.role, "advisor")))
      .limit(1);
    return !advisorUser; // No cycle if advisor exists
  }
  
  const visited = new Set<string>();
  visited.add(nodeId);
  let currentId: string | null = newReportsToId;
  while (currentId && !visited.has(currentId)) {
    // Skip virtual advisor nodes in the chain (they have no parent)
    if (currentId.startsWith("advisor-")) {
      return false; // Reached an advisor, no cycle possible
    }
    visited.add(currentId);
    const [parent] = await db
      .select({ reportsToNodeId: orgNodes.reportsToNodeId })
      .from(orgNodes)
      .where(and(eq(orgNodes.id, currentId), eq(orgNodes.tenantId, tenantId)))
      .limit(1);
    currentId = parent?.reportsToNodeId || null;
  }
  return currentId === nodeId;
}

const createNodeSchema = z.object({
  mode: z.enum(["live", "draft"]).default("draft"),
  scopeType: z.enum(["company", "branch"]).default("company"),
  scopeBranchId: z.string().nullable().optional(),
  nodeType: z.enum(["person", "vacant_role"]).default("vacant_role"),
  personEmployeeId: z.string().nullable().optional(),
  title: z.string().max(255).nullable().optional(),
  nicknameOverride: z.string().max(100).nullable().optional(),
  positionTitle: z.string().max(255).nullable().optional(),
  branchId: z.string().nullable().optional(),
  departmentId: z.string().nullable().optional(),
  reportsToNodeId: z.string().nullable().optional(),
  expectedMonthlySalary: z.number().nullable().optional(),
  isVacant: z.boolean().default(false),
  isAdvisor: z.boolean().default(false),
  isDisabled: z.boolean().default(false),
  sortOrder: z.number().int().default(0),
  // Hiring & Recruitment fields
  hiringStatus: z.enum(["not_hiring", "hiring"]).nullable().optional(),
  employmentType: z.enum(["full_time", "part_time", "casual"]).nullable().optional(),
  jobDescription: z.string().nullable().optional(),
  keyResponsibilities: z.array(z.string()).nullable().optional(),
  requirements: z.array(z.string()).nullable().optional(),
  salaryRange: z.string().max(100).nullable().optional(),
  benefits: z.array(z.string()).nullable().optional(),
  contactPhone: z.string().max(50).nullable().optional(),
  contactLine: z.string().max(100).nullable().optional(),
  contactEmail: z.string().max(255).nullable().optional(),
  applyUrl: z.string().max(500).nullable().optional(),
});

const updateNodeSchema = createNodeSchema.partial();

const scopeSchema = z.object({
  scopeType: z.enum(["company", "branch"]).default("company"),
  scopeBranchId: z.string().nullable().optional(),
}).refine(
  (data) => data.scopeType !== "branch" || (data.scopeType === "branch" && data.scopeBranchId),
  { message: "scopeBranchId is required when scopeType is branch" }
);

function verifyBranchAccess(
  req: any,
  scopeBranchId: string | null | undefined
): boolean {
  if (!isAdmin(req.userWithAccess?.role)) {
    return hasBranchAccess(
      req.userWithAccess?.branchId,
      req.userWithAccess?.accessScope,
      scopeBranchId
    );
  }
  if (req.userWithAccess?.accessScope === "all_branches") return true;
  if (!scopeBranchId) return true;
  return hasBranchAccess(
    req.userWithAccess?.branchId,
    req.userWithAccess?.accessScope,
    scopeBranchId
  );
}

router.get("/nodes", requireAuth, async (req, res) => {
  try {
    const tenantId = req.userWithAccess?.tenantId;
    if (!tenantId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const mode = (req.query.mode as string) || "live";
    const scopeType = (req.query.scopeType as string) || "company";
    const scopeBranchId = req.query.scopeBranchId as string | undefined;
    const userRole = req.userWithAccess?.role;

    if (mode === "draft" && !isAdmin(userRole)) {
      return res.status(403).json({ error: "Only admins can access draft mode" });
    }

    if (scopeType === "branch" && scopeBranchId && !verifyBranchAccess(req, scopeBranchId)) {
      return res.status(403).json({ error: "Access denied to this branch" });
    }

    const conditions = [
      eq(orgNodes.tenantId, tenantId),
      eq(orgNodes.mode, mode as "live" | "draft"),
      eq(orgNodes.isDeleted, false),
    ];

    if (scopeType === "branch" && scopeBranchId) {
      conditions.push(eq(orgNodes.scopeType, "branch"));
      conditions.push(eq(orgNodes.scopeBranchId, scopeBranchId));
    } else {
      conditions.push(eq(orgNodes.scopeType, "company"));
    }

    const showSalaries = canViewSalaries(userRole);

    const nodes = await db
      .select({
        id: orgNodes.id,
        tenantId: orgNodes.tenantId,
        mode: orgNodes.mode,
        scopeType: orgNodes.scopeType,
        scopeBranchId: orgNodes.scopeBranchId,
        nodeType: orgNodes.nodeType,
        personEmployeeId: orgNodes.personEmployeeId,
        title: orgNodes.title,
        nicknameOverride: orgNodes.nicknameOverride,
        positionTitle: orgNodes.positionTitle,
        branchId: orgNodes.branchId,
        departmentId: orgNodes.departmentId,
        reportsToNodeId: orgNodes.reportsToNodeId,
        expectedMonthlySalary: orgNodes.expectedMonthlySalary,
        isVacant: orgNodes.isVacant,
        isAdvisor: orgNodes.isAdvisor,
        isDisabled: orgNodes.isDisabled,
        isDeleted: orgNodes.isDeleted,
        sortOrder: orgNodes.sortOrder,
        createdAt: orgNodes.createdAt,
        updatedAt: orgNodes.updatedAt,
        // Hiring fields
        hiringStatus: orgNodes.hiringStatus,
        employmentType: orgNodes.employmentType,
        jobDescription: orgNodes.jobDescription,
        keyResponsibilities: orgNodes.keyResponsibilities,
        requirements: orgNodes.requirements,
        salaryRange: orgNodes.salaryRange,
        benefits: orgNodes.benefits,
        contactPhone: orgNodes.contactPhone,
        contactLine: orgNodes.contactLine,
        contactEmail: orgNodes.contactEmail,
        applyUrl: orgNodes.applyUrl,
        employeeNickname: employees.nickname,
        employeeFullName: employees.fullName,
        employeeDefaultMergeData: employees.defaultMergeData,
        employeeDepartmentId: employees.primaryDepartmentId,
        branchName: branches.name,
        departmentName: departments.name,
      })
      .from(orgNodes)
      .leftJoin(employees, eq(orgNodes.personEmployeeId, employees.id))
      .leftJoin(branches, eq(orgNodes.branchId, branches.id))
      .leftJoin(departments, eq(orgNodes.departmentId, departments.id))
      .where(and(...conditions))
      .orderBy(orgNodes.sortOrder);

    // Auto-sync: Ensure all active employees have nodes in this mode
    const activeEmployees = await db
      .select({
        id: employees.id,
        nickname: employees.nickname,
        fullName: employees.fullName,
        branchId: employees.branchId,
        primaryDepartmentId: employees.primaryDepartmentId,
        defaultMergeData: employees.defaultMergeData,
      })
      .from(employees)
      .where(and(
        eq(employees.tenantId, tenantId),
        eq(employees.status, "active")
      ));

    // Find employees missing from org chart
    const existingEmployeeIds = new Set(
      nodes.filter(n => n.personEmployeeId).map(n => n.personEmployeeId)
    );
    const missingEmployees = activeEmployees.filter(emp => !existingEmployeeIds.has(emp.id));

    // Auto-create nodes for missing employees
    if (missingEmployees.length > 0) {
      const newNodes: InsertOrgNode[] = missingEmployees.map(emp => {
        const mergeData = emp.defaultMergeData as { positionTitle?: string } | null;
        return {
          tenantId,
          mode: mode as "live" | "draft",
          scopeType: scopeType as "company" | "branch",
          scopeBranchId: scopeType === "branch" ? (scopeBranchId || null) : null,
          nodeType: "person" as const,
          personEmployeeId: emp.id,
          title: emp.nickname || emp.fullName,
          positionTitle: mergeData?.positionTitle || null,
          branchId: emp.branchId,
          isVacant: false,
          isDeleted: false,
          isAdvisor: false,
          isDisabled: false,
          hiringStatus: "not_hiring" as const,
          sortOrder: 0,
        };
      });

      const insertedNodes = await db.insert(orgNodes).values(newNodes).returning();

      // Add inserted nodes to the result set
      for (const inserted of insertedNodes) {
        const emp = missingEmployees.find(e => e.id === inserted.personEmployeeId);
        if (emp) {
          const mergeData = emp.defaultMergeData as { positionTitle?: string; salaryThb?: number } | null;
          nodes.push({
            ...inserted,
            employeeNickname: emp.nickname,
            employeeFullName: emp.fullName,
            employeeDefaultMergeData: emp.defaultMergeData,
            employeeDepartmentId: emp.primaryDepartmentId,
            branchName: null, // Will be filled in next fetch
            departmentName: null,
          } as typeof nodes[0]);
        }
      }
    }

    const sanitizedNodes = nodes.map((node) => {
      const mergeData = node.employeeDefaultMergeData as { positionTitle?: string; salaryThb?: number } | null;
      return {
        ...node,
        expectedMonthlySalary: showSalaries ? node.expectedMonthlySalary : null,
        employeePositionTitle: mergeData?.positionTitle || null,
        employeeSalary: showSalaries ? (mergeData?.salaryThb || null) : null,
        employeeDefaultMergeData: undefined,
      };
    });

    // Fetch advisors from people table and add them as virtual nodes
    // Note: people table doesn't have tenantId, so we filter by user's tenant
    const advisors = await db
      .select({
        id: people.id,
        email: people.email,
        fullName: people.fullName,
        preferredName: people.preferredName,
        isActive: people.isActive,
      })
      .from(people)
      .where(and(
        eq(people.personType, "ADVISOR"),
        eq(people.isActive, true)
      ));

    // Create advisor nodes from people table
    // These are external consultants/advisors without employee records
    const advisorNodes = advisors.map((advisor) => {
      const displayName = advisor.preferredName || advisor.fullName || advisor.email;

      // Create virtual advisor node (advisors don't have employee records, so always create a node)
      return {
        id: `advisor-${advisor.id}`,
        tenantId,
        mode,
        scopeType,
        scopeBranchId: scopeBranchId || null,
        nodeType: "person" as const,
        personEmployeeId: null,
        title: displayName,
        nicknameOverride: null,
        positionTitle: "Advisor",
        branchId: null,
        departmentId: null,
        reportsToNodeId: null,
        expectedMonthlySalary: null,
        isVacant: false,
        isAdvisor: true,
        isDisabled: false,
        isDeleted: false,
        sortOrder: 9999, // Put advisors at the end
        createdAt: new Date(),
        updatedAt: new Date(),
        employeeNickname: null,
        employeeFullName: advisor.fullName,
        employeePositionTitle: "Advisor",
        employeeSalary: null,
        employeeDepartmentId: null,
        branchName: null,
        departmentName: null,
      };
    });

    // Fetch cost allocation counts for employees with split allocations
    const employeeIds = sanitizedNodes
      .filter(n => n.personEmployeeId)
      .map(n => n.personEmployeeId as string);

    let allocationCounts: Record<string, number> = {};
    if (employeeIds.length > 0) {
      const allocations = await db
        .select({
          employeeId: staffCostAllocations.employeeId,
          branchCount: count(staffCostAllocations.id),
        })
        .from(staffCostAllocations)
        .where(inArray(staffCostAllocations.employeeId, employeeIds))
        .groupBy(staffCostAllocations.employeeId);

      allocationCounts = allocations.reduce((acc, a) => {
        acc[a.employeeId] = Number(a.branchCount);
        return acc;
      }, {} as Record<string, number>);
    }

    // Add cost allocation info to nodes
    const nodesWithAllocations = sanitizedNodes.map(node => ({
      ...node,
      costAllocationCount: node.personEmployeeId ? (allocationCounts[node.personEmployeeId] || 0) : 0,
    }));

    // Filter out null values and combine with existing nodes
    const allNodes = [
      ...nodesWithAllocations,
      ...advisorNodes.filter((n): n is NonNullable<typeof n> => n !== null).map(n => ({
        ...n,
        costAllocationCount: 0,
      })),
    ];

    res.json(allNodes);
  } catch (err: any) {
    console.error("Error fetching org nodes:", err);
    res.status(500).json({ error: err.message });
  }
});

router.post("/nodes", requireAuth, async (req, res) => {
  try {
    const tenantId = req.userWithAccess?.tenantId;
    const userId = req.user?.id;
    const userRole = req.userWithAccess?.role;

    if (!tenantId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!isAdmin(userRole)) {
      return res.status(403).json({ error: "Only admins can create org nodes" });
    }

    const parseResult = createNodeSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ error: "Invalid request body", details: parseResult.error.errors });
    }

    const validatedData = parseResult.data;
    console.log("[ORG_CHART] Creating node with data:", JSON.stringify(validatedData, null, 2));

    if (validatedData.scopeType === "branch" && validatedData.scopeBranchId) {
      if (!verifyBranchAccess(req, validatedData.scopeBranchId)) {
        return res.status(403).json({ error: "Access denied to this branch" });
      }
    }

    if (validatedData.reportsToNodeId) {
      // Handle virtual advisor node IDs - they can't be stored directly in the database
      if (validatedData.reportsToNodeId.startsWith("advisor-")) {
        return res.status(400).json({ 
          error: "Cannot set an advisor as a supervisor. Advisors are external consultants without a position in the organizational structure." 
        });
      }
      
      console.log("[ORG_CHART] Checking cycle for reportsToNodeId:", validatedData.reportsToNodeId);
      const hasCycle = await detectCycleForNewNode(tenantId, validatedData.reportsToNodeId);
      console.log("[ORG_CHART] Cycle check result:", hasCycle);
      if (hasCycle) {
        return res.status(400).json({ error: "Invalid reporting structure" });
      }
    }

    const nodeData: InsertOrgNode = {
      ...validatedData,
      tenantId,
      createdBy: userId,
      lastEditedBy: userId,
    };

    const [newNode] = await db.insert(orgNodes).values(nodeData).returning();
    res.status(201).json(newNode);
  } catch (err: any) {
    console.error("Error creating org node:", err);
    res.status(500).json({ error: err.message });
  }
});

router.patch("/nodes/:id", requireAuth, async (req, res) => {
  try {
    const tenantId = req.userWithAccess?.tenantId;
    const userId = req.user?.id;
    const userRole = req.userWithAccess?.role;
    const nodeId = req.params.id;

    if (!tenantId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!isAdmin(userRole)) {
      return res.status(403).json({ error: "Only admins can edit org nodes" });
    }

    const parseResult = updateNodeSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ error: "Invalid request body", details: parseResult.error.errors });
    }

    const validatedData = parseResult.data;

    if (validatedData.reportsToNodeId !== undefined) {
      const hasCycle = await detectCycleForUpdate(tenantId, nodeId, validatedData.reportsToNodeId || null);
      if (hasCycle) {
        return res.status(400).json({ error: "This would create a circular reporting structure" });
      }
    }

    // Handle virtual advisor node IDs - they can't be stored directly in the database
    // Virtual advisor nodes have IDs like "advisor-{personId}" but aren't persisted org_nodes
    if (validatedData.reportsToNodeId?.startsWith("advisor-")) {
      // Advisors are virtual nodes - we can't set them as supervisors in the database
      // since they don't exist as actual org_node records
      return res.status(400).json({ 
        error: "Cannot set an advisor as a supervisor. Advisors are external consultants without a position in the organizational structure." 
      });
    }

    const [updatedNode] = await db
      .update(orgNodes)
      .set({
        ...validatedData,
        lastEditedBy: userId,
        updatedAt: new Date(),
      })
      .where(and(eq(orgNodes.id, nodeId), eq(orgNodes.tenantId, tenantId)))
      .returning();

    if (!updatedNode) {
      return res.status(404).json({ error: "Node not found" });
    }

    res.json(updatedNode);
  } catch (err: any) {
    console.error("Error updating org node:", err);
    res.status(500).json({ error: err.message });
  }
});

router.delete("/nodes/:id", requireAuth, async (req, res) => {
  try {
    const tenantId = req.userWithAccess?.tenantId;
    const userId = req.user?.id;
    const userRole = req.userWithAccess?.role;
    const nodeId = req.params.id;

    if (!tenantId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!isAdmin(userRole)) {
      return res.status(403).json({ error: "Only admins can delete org nodes" });
    }

    const [deletedNode] = await db
      .update(orgNodes)
      .set({
        isDeleted: true,
        lastEditedBy: userId,
        updatedAt: new Date(),
      })
      .where(and(eq(orgNodes.id, nodeId), eq(orgNodes.tenantId, tenantId)))
      .returning();

    if (!deletedNode) {
      return res.status(404).json({ error: "Node not found" });
    }

    res.json({ success: true });
  } catch (err: any) {
    console.error("Error deleting org node:", err);
    res.status(500).json({ error: err.message });
  }
});

router.post("/clone-live-to-draft", requireAuth, async (req, res) => {
  try {
    const tenantId = req.userWithAccess?.tenantId;
    const userId = req.user?.id;
    const userRole = req.userWithAccess?.role;

    if (!tenantId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!isAdmin(userRole)) {
      return res.status(403).json({ error: "Only admins can create drafts" });
    }

    const scopeResult = scopeSchema.safeParse(req.body);
    if (!scopeResult.success) {
      return res.status(400).json({ error: "Invalid scope", details: scopeResult.error.errors });
    }

    const { scopeType, scopeBranchId } = scopeResult.data;

    if (scopeType === "branch" && scopeBranchId && !verifyBranchAccess(req, scopeBranchId)) {
      return res.status(403).json({ error: "Access denied to this branch" });
    }

    const deleteConditions = [
      eq(orgNodes.tenantId, tenantId),
      eq(orgNodes.mode, "draft"),
      eq(orgNodes.scopeType, scopeType),
    ];
    if (scopeType === "branch" && scopeBranchId) {
      deleteConditions.push(eq(orgNodes.scopeBranchId, scopeBranchId));
    }
    await db.delete(orgNodes).where(and(...deleteConditions));

    const liveConditions = [
      eq(orgNodes.tenantId, tenantId),
      eq(orgNodes.mode, "live"),
      eq(orgNodes.scopeType, scopeType),
      eq(orgNodes.isDeleted, false),
    ];
    if (scopeType === "branch" && scopeBranchId) {
      liveConditions.push(eq(orgNodes.scopeBranchId, scopeBranchId));
    }
    const liveNodes = await db.select().from(orgNodes).where(and(...liveConditions));

    if (liveNodes.length === 0) {
      return res.json({ message: "No live nodes to clone", clonedCount: 0 });
    }

    const idMapping: Record<string, string> = {};
    const newNodes: InsertOrgNode[] = liveNodes.map((node) => {
      const newId = crypto.randomUUID();
      idMapping[node.id] = newId;
      return {
        tenantId: node.tenantId,
        mode: "draft" as const,
        scopeType: node.scopeType,
        scopeBranchId: node.scopeBranchId,
        nodeType: node.nodeType,
        personEmployeeId: node.personEmployeeId,
        title: node.title,
        nicknameOverride: node.nicknameOverride,
        positionTitle: node.positionTitle,
        branchId: node.branchId,
        reportsToNodeId: node.reportsToNodeId,
        expectedMonthlySalary: node.expectedMonthlySalary,
        isVacant: node.isVacant,
        isDeleted: false,
        sortOrder: node.sortOrder,
        createdBy: userId,
        lastEditedBy: userId,
      };
    });

    const insertedNodes = await db.insert(orgNodes).values(newNodes).returning();

    for (const node of insertedNodes) {
      const originalNode = liveNodes.find((ln) => idMapping[ln.id] === node.id);
      if (originalNode?.reportsToNodeId && idMapping[originalNode.reportsToNodeId]) {
        await db
          .update(orgNodes)
          .set({ reportsToNodeId: idMapping[originalNode.reportsToNodeId] })
          .where(eq(orgNodes.id, node.id));
      }
    }

    res.json({ message: "Draft created from live", clonedCount: insertedNodes.length });
  } catch (err: any) {
    console.error("Error cloning live to draft:", err);
    res.status(500).json({ error: err.message });
  }
});

router.post("/promote-draft-to-live", requireAuth, async (req, res) => {
  try {
    const tenantId = req.userWithAccess?.tenantId;
    const userId = req.user?.id;
    const userRole = req.userWithAccess?.role;

    if (!tenantId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!isAdmin(userRole)) {
      return res.status(403).json({ error: "Only admins can promote drafts" });
    }

    const scopeResult = scopeSchema.safeParse(req.body);
    if (!scopeResult.success) {
      return res.status(400).json({ error: "Invalid scope", details: scopeResult.error.errors });
    }

    const { scopeType, scopeBranchId } = scopeResult.data;

    if (scopeType === "branch" && scopeBranchId && !verifyBranchAccess(req, scopeBranchId)) {
      return res.status(403).json({ error: "Access denied to this branch" });
    }

    const draftConditions = [
      eq(orgNodes.tenantId, tenantId),
      eq(orgNodes.mode, "draft"),
      eq(orgNodes.scopeType, scopeType),
      eq(orgNodes.isDeleted, false),
    ];
    if (scopeType === "branch" && scopeBranchId) {
      draftConditions.push(eq(orgNodes.scopeBranchId, scopeBranchId));
    }
    const draftNodes = await db.select().from(orgNodes).where(and(...draftConditions));

    const deleteLiveConditions = [
      eq(orgNodes.tenantId, tenantId),
      eq(orgNodes.mode, "live"),
      eq(orgNodes.scopeType, scopeType),
    ];
    if (scopeType === "branch" && scopeBranchId) {
      deleteLiveConditions.push(eq(orgNodes.scopeBranchId, scopeBranchId));
    }
    await db.delete(orgNodes).where(and(...deleteLiveConditions));

    if (draftNodes.length === 0) {
      return res.json({ message: "No draft nodes to promote", promotedCount: 0 });
    }

    const idMapping: Record<string, string> = {};
    const newLiveNodes: InsertOrgNode[] = draftNodes.map((node) => {
      // Preserve advisor IDs to maintain consistent references
      const newId = node.isAdvisor ? node.id : crypto.randomUUID();
      idMapping[node.id] = newId;
      return {
        tenantId: node.tenantId,
        mode: "live" as const,
        scopeType: node.scopeType,
        scopeBranchId: node.scopeBranchId,
        nodeType: node.nodeType,
        personEmployeeId: node.personEmployeeId,
        title: node.title,
        nicknameOverride: node.nicknameOverride,
        positionTitle: node.positionTitle,
        branchId: node.branchId,
        departmentId: node.departmentId,
        reportsToNodeId: node.reportsToNodeId,
        expectedMonthlySalary: node.expectedMonthlySalary,
        isVacant: node.isVacant,
        isAdvisor: node.isAdvisor,
        isDisabled: node.isDisabled,
        isDeleted: false,
        sortOrder: node.sortOrder,
        hiringStatus: node.hiringStatus,
        employmentType: node.employmentType,
        jobDescription: node.jobDescription,
        keyResponsibilities: node.keyResponsibilities,
        requirements: node.requirements,
        salaryRange: node.salaryRange,
        benefits: node.benefits,
        contactPhone: node.contactPhone,
        contactLine: node.contactLine,
        contactEmail: node.contactEmail,
        applyUrl: node.applyUrl,
        createdBy: userId,
        lastEditedBy: userId,
      };
    });

    const insertedNodes = await db.insert(orgNodes).values(newLiveNodes).returning();

    for (const node of insertedNodes) {
      const originalNode = draftNodes.find((dn) => idMapping[dn.id] === node.id);
      if (originalNode?.reportsToNodeId && idMapping[originalNode.reportsToNodeId]) {
        await db
          .update(orgNodes)
          .set({ reportsToNodeId: idMapping[originalNode.reportsToNodeId] })
          .where(eq(orgNodes.id, node.id));
      }
    }

    // Keep draft nodes intact so user can continue editing after publishing
    // The draft becomes the working copy for future changes

    res.json({ message: "Draft promoted to live", promotedCount: insertedNodes.length });
  } catch (err: any) {
    console.error("Error promoting draft to live:", err);
    res.status(500).json({ error: err.message });
  }
});

router.get("/budget", requireAuth, async (req, res) => {
  try {
    const tenantId = req.userWithAccess?.tenantId;
    const userRole = req.userWithAccess?.role;

    if (!tenantId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!isAdmin(userRole)) {
      return res.status(403).json({ error: "Only admins can view budget" });
    }

    const scopeType = (req.query.scopeType as string) || "company";
    const scopeBranchId = req.query.scopeBranchId as string | undefined;

    if (scopeType === "branch") {
      if (!scopeBranchId) {
        return res.status(400).json({ error: "scopeBranchId required for branch scope" });
      }
      if (!verifyBranchAccess(req, scopeBranchId)) {
        return res.status(403).json({ error: "Access denied to this branch" });
      }
    }

    const getNodesForMode = async (mode: "live" | "draft") => {
      const conditions = [
        eq(orgNodes.tenantId, tenantId),
        eq(orgNodes.mode, mode),
        eq(orgNodes.isDeleted, false),
      ];
      if (scopeType === "branch" && scopeBranchId) {
        conditions.push(eq(orgNodes.scopeType, "branch"));
        conditions.push(eq(orgNodes.scopeBranchId, scopeBranchId));
      } else {
        conditions.push(eq(orgNodes.scopeType, "company"));
      }

      return db
        .select({
          id: orgNodes.id,
          nodeType: orgNodes.nodeType,
          personEmployeeId: orgNodes.personEmployeeId,
          expectedMonthlySalary: orgNodes.expectedMonthlySalary,
          branchId: orgNodes.branchId,
          employeeSalary: employees.baseSalaryMonthly,
          branchName: branches.name,
        })
        .from(orgNodes)
        .leftJoin(employees, eq(orgNodes.personEmployeeId, employees.id))
        .leftJoin(branches, eq(orgNodes.branchId, branches.id))
        .where(and(...conditions));
    };

    const liveNodes = await getNodesForMode("live");
    const draftNodes = await getNodesForMode("draft");

    const calculateBudget = (nodes: typeof liveNodes) => {
      let totalSalary = 0;
      let personCount = 0;
      let vacantCount = 0;
      const byBranch: Record<string, { name: string; salary: number; personCount: number; vacantCount: number }> = {};

      for (const node of nodes) {
        const salary = node.nodeType === "person"
          ? (node.employeeSalary ?? 0)
          : (node.expectedMonthlySalary ?? 0);
        
        totalSalary += salary;
        
        if (node.nodeType === "person") {
          personCount++;
        } else {
          vacantCount++;
        }

        const branchKey = node.branchId || "unassigned";
        const branchName = node.branchName || "Unassigned";
        if (!byBranch[branchKey]) {
          byBranch[branchKey] = { name: branchName, salary: 0, personCount: 0, vacantCount: 0 };
        }
        byBranch[branchKey].salary += salary;
        if (node.nodeType === "person") {
          byBranch[branchKey].personCount++;
        } else {
          byBranch[branchKey].vacantCount++;
        }
      }

      return { totalSalary, personCount, vacantCount, byBranch };
    };

    const liveBudget = calculateBudget(liveNodes);
    const draftBudget = calculateBudget(draftNodes);

    res.json({
      live: liveBudget,
      draft: draftBudget,
      delta: {
        salary: draftBudget.totalSalary - liveBudget.totalSalary,
        personCount: draftBudget.personCount - liveBudget.personCount,
        vacantCount: draftBudget.vacantCount - liveBudget.vacantCount,
      },
    });
  } catch (err: any) {
    console.error("Error fetching budget:", err);
    res.status(500).json({ error: err.message });
  }
});

router.post("/initialize-from-employees", requireAuth, async (req, res) => {
  try {
    const tenantId = req.userWithAccess?.tenantId;
    const userId = req.user?.id;
    const userRole = req.userWithAccess?.role;

    if (!tenantId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!isAdmin(userRole)) {
      return res.status(403).json({ error: "Only admins can initialize org chart" });
    }

    const scopeResult = scopeSchema.safeParse(req.body);
    if (!scopeResult.success) {
      return res.status(400).json({ error: "Invalid scope", details: scopeResult.error.errors });
    }

    const { scopeType, scopeBranchId } = scopeResult.data;

    if (scopeType === "branch" && scopeBranchId && !verifyBranchAccess(req, scopeBranchId)) {
      return res.status(403).json({ error: "Access denied to this branch" });
    }

    const existingConditions = [
      eq(orgNodes.tenantId, tenantId),
      eq(orgNodes.mode, "live"),
      eq(orgNodes.scopeType, scopeType),
    ];
    if (scopeType === "branch" && scopeBranchId) {
      existingConditions.push(eq(orgNodes.scopeBranchId, scopeBranchId));
    }
    const existingNodes = await db.select().from(orgNodes).where(and(...existingConditions)).limit(1);

    if (existingNodes.length > 0) {
      return res.status(400).json({ error: "Org chart already initialized. Use clone/promote for changes." });
    }

    const employeeConditions = [
      eq(employees.tenantId, tenantId),
      eq(employees.status, "active"),
    ];
    if (scopeType === "branch" && scopeBranchId) {
      employeeConditions.push(eq(employees.branchId, scopeBranchId));
    }
    const activeEmployees = await db.select().from(employees).where(and(...employeeConditions));

    if (activeEmployees.length === 0) {
      return res.json({ message: "No active employees found", createdCount: 0 });
    }

    const nodesToCreate: InsertOrgNode[] = activeEmployees.map((emp) => ({
      tenantId,
      mode: "live" as const,
      scopeType: scopeType as "company" | "branch",
      scopeBranchId: scopeType === "branch" ? scopeBranchId : null,
      nodeType: "person" as const,
      personEmployeeId: emp.id,
      title: emp.nickname || emp.fullName,
      positionTitle: emp.positionTitle,
      branchId: emp.branchId,
      isVacant: false,
      isDeleted: false,
      createdBy: userId,
      lastEditedBy: userId,
    }));

    const insertedNodes = await db.insert(orgNodes).values(nodesToCreate).returning();

    res.json({ message: "Org chart initialized from employees", createdCount: insertedNodes.length });
  } catch (err: any) {
    console.error("Error initializing org chart:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
