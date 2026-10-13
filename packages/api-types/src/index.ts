/**
 * What the api sends and reads, as the api itself describes it (SCRUM-272).
 *
 * `./openapi.ts` is GENERATED from the api's OpenAPI document — which
 * `@fastify/swagger` builds from the zod schemas every route declares — by
 * `pnpm api-types:generate` (apps/api/scripts/api-types.ts). CI runs
 * `pnpm api-types:check`, so a route schema changed without regenerating
 * fails the build, and a front end typed from here fails its typecheck the
 * day the server's shape moves away from it.
 *
 * A screen names a route the way the document spells it — `{param}`, not
 * `:param` — and a method in lower case:
 *
 *   api.get<ApiResponse<'/benefits/templates', 'get'>>('/benefits/templates')
 *
 * The seam walker (test/seam-walker.test.ts, SCRUM-293) checks that the route
 * named in the type argument is the route the call's path actually reaches,
 * so the type cannot describe one endpoint while the request goes to another.
 *
 * A route whose schema declares no response body has no type to give:
 * `ApiResponse` is `unknown` there, which a caller has to narrow rather than
 * trust.
 */
import type { paths } from './openapi';

export type { components, operations, paths } from './openapi';

/** Every route path the api describes, `{param}` spelling. */
export type ApiPath = keyof paths;

/** The HTTP methods a route path answers, in lower case. */
export type ApiMethod<P extends ApiPath> = {
  [M in 'get' | 'put' | 'post' | 'delete' | 'patch']: [NonNullable<paths[P][M]>] extends [never]
    ? never
    : M;
}['get' | 'put' | 'post' | 'delete' | 'patch'];

type Operation<P extends ApiPath, M extends ApiMethod<P>> = NonNullable<paths[P][M]>;

type JsonOf<R> = R extends { content: { 'application/json': infer T } } ? T : unknown;

/**
 * The body of the route's success answer: its 200, else its 201. `unknown`
 * where the route's schema declares none.
 */
export type ApiResponse<P extends ApiPath, M extends ApiMethod<P>> =
  Operation<P, M> extends { responses: infer R }
    ? R extends { 200: infer Ok }
      ? JsonOf<Ok>
      : R extends { 201: infer Created }
        ? JsonOf<Created>
        : unknown
    : unknown;

/** The JSON body the route reads. `never` for a route that reads none. */
export type ApiBody<P extends ApiPath, M extends ApiMethod<P>> =
  Operation<P, M> extends { requestBody?: infer B }
    ? NonNullable<B> extends { content: { 'application/json': infer T } }
      ? T
      : never
    : never;

/** The route's query-string parameters. */
export type ApiQuery<P extends ApiPath, M extends ApiMethod<P>> =
  Operation<P, M> extends { parameters: { query?: infer Q } } ? NonNullable<Q> : never;

/** The route's path parameters. */
export type ApiParams<P extends ApiPath, M extends ApiMethod<P>> =
  Operation<P, M> extends { parameters: { path?: infer Q } } ? NonNullable<Q> : never;
