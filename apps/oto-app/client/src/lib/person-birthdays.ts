export interface PersonBirthday {
  id: string;
  personId: string;
  name: string;
  date: string;
  branchId: string | null;
  kind: "person_birthday";
  title: string;
}

export async function fetchPersonBirthdays(
  start: string,
  end: string,
  branchId?: string | null,
): Promise<PersonBirthday[]> {
  const params = new URLSearchParams({ start, end });
  if (branchId) params.set("branchId", branchId);
  const response = await fetch(`/api/birthdays?${params}`, { credentials: "include" });
  if (!response.ok) throw new Error("Failed to fetch birthdays");
  return response.json();
}