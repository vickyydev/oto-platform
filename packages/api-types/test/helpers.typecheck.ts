/**
 * Compile-time proof that the helpers in `src/index.ts` resolve to the shapes
 * the api declares, and to `unknown` where it declares none. Nothing runs:
 * `pnpm --filter @oto/api-types typecheck` is the test, and a helper that
 * quietly widened to `any` or narrowed to `never` fails it here.
 */
import type { ApiBody, ApiMethod, ApiQuery, ApiResponse } from '../src/index';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const holds = <T extends true>(): T => true as T;

// A described answer is the declared object, field for field.
type Templates = ApiResponse<'/benefits/templates', 'get'>;
holds<Equal<Templates['today'], string>>();
holds<Equal<Templates['templates'][number]['role'], 'owner' | 'manager' | 'staff'>>();

// A body and a query are what the route reads.
holds<Equal<ApiBody<'/benefits/resolve', 'post'>, { code: string }>>();
holds<Equal<keyof ApiQuery<'/benefits/credentials', 'get'>, 'employeeId'>>();

// The methods a path answers, and no others.
holds<Equal<ApiMethod<'/benefits/templates/{role}'>, 'get' | 'put'>>();

// No response schema on the route: unknown, which a caller must narrow.
holds<Equal<ApiResponse<'/members/lookup', 'get'>, unknown>>();

// @ts-expect-error — a method the route does not answer is refused.
export type Refused = ApiResponse<'/benefits/templates', 'post'>;
