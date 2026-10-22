import { createOrganisationAdminApi } from '@oto/admin-screens/lifted/api/platform';
import { apiBranchToBranch, holidayToPricingOverride } from '@oto/admin-screens/lifted/api/mappers';
import { api } from './client';

/** The original shared calls, using this Console's authenticated transport. */
export const organisationApi = createOrganisationAdminApi(api);
export { apiBranchToBranch, holidayToPricingOverride };
export type OrganisationBranch = Awaited<
  ReturnType<typeof organisationApi.branchesApi.list>
>['branches'][number];
