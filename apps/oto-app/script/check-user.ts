import { db } from "../server/db";
import { users } from "../shared/schema";
import { eq } from "drizzle-orm";

const [u] = await db.select().from(users).where(eq(users.email, "joshua.sporer60.689@example.com"));
console.log(u);
process.exit(0);
