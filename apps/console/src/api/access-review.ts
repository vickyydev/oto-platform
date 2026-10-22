import type { ApiResponse } from '@oto/api-types';
import { api } from './client';

export type AccessReviewSnapshot = ApiResponse<'/access-review/', 'get'>;
export type AccessReviewAccount = AccessReviewSnapshot['accountsWithoutEmployee'][number];
export type AccessReviewHolder = AccessReviewSnapshot['operatorWideHolders'][number];
export type AccessReviewEmployee = AccessReviewSnapshot['employeesWithoutAccount'][number];

export const accessReviewApi = {
  read: () => api.get<ApiResponse<'/access-review/', 'get'>>('/access-review'),
};
