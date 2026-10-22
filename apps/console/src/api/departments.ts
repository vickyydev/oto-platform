import type { ApiResponse } from '@oto/api-types';
import { api, qs } from './client';

export type DepartmentDirectory = ApiResponse<'/departments/', 'get'>;
export type DirectoryDepartment = DepartmentDirectory['departments'][number];

export const departmentsApi = {
  read: (query: string) => api.get<ApiResponse<'/departments/', 'get'>>(`/departments${qs({ q: query })}`),
};
