type EmployeeLike = {
  id?: string;
  nickname?: string | null;
  preferredName?: string | null;
  fullName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  name?: string | null;
  departmentName?: string | null;
  branchName?: string | null;
  roleName?: string | null;
};

type DisplayContext = "default" | "employee_page" | "official_document";

export function getEmployeeDisplayName(
  employee: EmployeeLike | null | undefined,
  context: DisplayContext = "default"
): string {
  if (!employee) return "Unknown";

  const fullName = employee.fullName || 
    (employee.firstName && employee.lastName 
      ? `${employee.firstName} ${employee.lastName}` 
      : employee.firstName || employee.lastName || employee.name || "Unknown");

  if (context === "employee_page" || context === "official_document") {
    return fullName;
  }

  if (employee.nickname && employee.nickname.trim()) {
    return employee.nickname.trim();
  }
  
  if (employee.preferredName && employee.preferredName.trim()) {
    return employee.preferredName.trim();
  }

  return fullName;
}

export function getEmployeePickerLabel(
  employee: EmployeeLike | null | undefined,
  allEmployees?: EmployeeLike[]
): { primary: string; secondary?: string; searchTerms: string[] } {
  if (!employee) {
    return { primary: "Unknown", searchTerms: [] };
  }

  const fullName = employee.fullName || 
    (employee.firstName && employee.lastName 
      ? `${employee.firstName} ${employee.lastName}` 
      : employee.firstName || employee.lastName || employee.name || "");

  const nickname = employee.nickname?.trim() || employee.preferredName?.trim() || "";
  const primary = nickname || fullName || "Unknown";
  
  const searchTerms = [
    nickname,
    fullName,
    employee.firstName,
    employee.lastName,
    employee.name,
  ].filter(Boolean) as string[];

  if (!allEmployees || allEmployees.length === 0) {
    return { 
      primary, 
      secondary: nickname && fullName && nickname !== fullName ? fullName : undefined,
      searchTerms 
    };
  }

  const duplicates = allEmployees.filter(e => 
    e.id !== employee.id && 
    getEmployeeDisplayName(e) === primary
  );

  if (duplicates.length === 0) {
    return { 
      primary, 
      secondary: nickname && fullName && nickname !== fullName ? fullName : undefined,
      searchTerms 
    };
  }

  let disambiguator = "";
  if (employee.departmentName) {
    disambiguator = employee.departmentName;
  } else if (employee.branchName) {
    disambiguator = employee.branchName;
  } else if (employee.roleName) {
    disambiguator = employee.roleName;
  } else if (fullName && nickname && fullName !== nickname) {
    const nameParts = fullName.split(" ");
    if (nameParts.length >= 2) {
      disambiguator = `${nameParts[0]} ${nameParts[1].charAt(0)}.`;
    } else {
      disambiguator = fullName;
    }
  }

  return {
    primary: disambiguator ? `${primary} — ${disambiguator}` : primary,
    secondary: fullName && primary !== fullName ? fullName : undefined,
    searchTerms,
  };
}

export function getInitials(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return `${parts[0].charAt(0)}${parts[parts.length - 1].charAt(0)}`.toUpperCase();
  }
  return name.charAt(0).toUpperCase();
}

export function formatEmployeeForPicker(employee: EmployeeLike, allEmployees?: EmployeeLike[]) {
  const { primary, secondary, searchTerms } = getEmployeePickerLabel(employee, allEmployees);
  return {
    value: employee.id || "",
    label: primary,
    sublabel: secondary,
    searchTerms,
    employee,
  };
}
