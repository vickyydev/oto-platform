import type { App } from '../app';
import { otoAppProvisionerOf } from '../plugins/credential';
import {
  PayrollBoothPage,
  PayrollBoothQuery,
  payrollBoothVouchers,
} from '../services/payroll-booth-vouchers';

export async function otoAppPayrollBoothRoutes(app: App): Promise<void> {
  app.get(
    '/payroll/booth-vouchers',
    {
      config: { credential: 'otoapp-provision' },
      schema: {
        description:
          'Printed booth vouchers and their first till redemption for a payroll month at a park belonging to the provisioning key.',
        querystring: PayrollBoothQuery,
        response: { 200: PayrollBoothPage },
      },
    },
    async (req) => payrollBoothVouchers(app.db, otoAppProvisionerOf(req).operatorId, req.query),
  );
}
