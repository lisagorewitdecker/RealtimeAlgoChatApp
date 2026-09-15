import type { QueryKey, UseMutationOptions, UseMutationResult, UseQueryOptions, UseQueryResult } from '@tanstack/react-query';
import type { CreateRoomRequest, HealthStatus, ProfileResponse, PublicKeyConflictResponse, RoomResponse, RoomsListResponse, UnauthorizedResponse, UpsertProfileRequest } from './api.schemas';
import { customFetch } from '../custom-fetch';
import type { ErrorType, BodyType } from '../custom-fetch';
type AwaitedInput<T> = PromiseLike<T> | T;
type Awaited<O> = O extends AwaitedInput<infer T> ? T : never;
type SecondParameter<T extends (...args: never) => unknown> = Parameters<T>[1];
export declare const getHealthCheckUrl: () => string;
/**
 * Returns server health status
 * @summary Health check
 */
export declare const healthCheck: (options?: Parameters<typeof customFetch>[1]) => Promise<HealthStatus>;
export declare const getHealthCheckQueryKey: () => readonly ["/api/healthz"];
export declare const getHealthCheckQueryOptions: <TData = Awaited<ReturnType<typeof healthCheck>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof healthCheck>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof healthCheck>>, TError, TData> & {
    queryKey: QueryKey;
};
export type HealthCheckQueryResult = NonNullable<Awaited<ReturnType<typeof healthCheck>>>;
export type HealthCheckQueryError = ErrorType<unknown>;
/**
 * @summary Health check
 */
export declare function useHealthCheck<TData = Awaited<ReturnType<typeof healthCheck>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof healthCheck>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getGetProfileUrl: () => string;
/**
 * @summary Get current user profile
 */
export declare const getProfile: (options?: Parameters<typeof customFetch>[1]) => Promise<ProfileResponse>;
export declare const getGetProfileQueryKey: () => readonly ["/api/profile"];
export declare const getGetProfileQueryOptions: <TData = Awaited<ReturnType<typeof getProfile>>, TError = ErrorType<UnauthorizedResponse | void>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getProfile>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getProfile>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetProfileQueryResult = NonNullable<Awaited<ReturnType<typeof getProfile>>>;
export type GetProfileQueryError = ErrorType<UnauthorizedResponse | void>;
/**
 * @summary Get current user profile
 */
export declare function useGetProfile<TData = Awaited<ReturnType<typeof getProfile>>, TError = ErrorType<UnauthorizedResponse | void>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getProfile>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getUpsertProfileUrl: () => string;
/**
 * @summary Create or update current user profile
 */
export declare const upsertProfile: (upsertProfileRequest: UpsertProfileRequest, options?: Parameters<typeof customFetch>[1]) => Promise<ProfileResponse>;
export declare const getUpsertProfileMutationKey: () => readonly ["upsertProfile"];
export declare const getUpsertProfileMutationOptions: <TError = ErrorType<void | UnauthorizedResponse | PublicKeyConflictResponse>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof upsertProfile>>, TError, UpsertProfileMutationVariables, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof upsertProfile>>, TError, UpsertProfileMutationVariables, TContext>;
export type UpsertProfileMutationResult = NonNullable<Awaited<ReturnType<typeof upsertProfile>>>;
export type UpsertProfileMutationBody = BodyType<UpsertProfileRequest>;
export type UpsertProfileMutationError = ErrorType<void | UnauthorizedResponse | PublicKeyConflictResponse>;
export type UpsertProfileMutationVariables = {
    data: BodyType<UpsertProfileRequest>;
};
/**
* @summary Create or update current user profile
*/
export declare const useUpsertProfile: <TError = ErrorType<void | UnauthorizedResponse | PublicKeyConflictResponse>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof upsertProfile>>, TError, UpsertProfileMutationVariables, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof upsertProfile>>, TError, UpsertProfileMutationVariables, TContext>;
export declare const getListRoomsUrl: () => string;
/**
 * @summary List active rooms
 */
export declare const listRooms: (options?: Parameters<typeof customFetch>[1]) => Promise<RoomsListResponse>;
export declare const getListRoomsQueryKey: () => readonly ["/api/rooms"];
export declare const getListRoomsQueryOptions: <TData = Awaited<ReturnType<typeof listRooms>>, TError = ErrorType<UnauthorizedResponse>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listRooms>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof listRooms>>, TError, TData> & {
    queryKey: QueryKey;
};
export type ListRoomsQueryResult = NonNullable<Awaited<ReturnType<typeof listRooms>>>;
export type ListRoomsQueryError = ErrorType<UnauthorizedResponse>;
/**
 * @summary List active rooms
 */
export declare function useListRooms<TData = Awaited<ReturnType<typeof listRooms>>, TError = ErrorType<UnauthorizedResponse>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listRooms>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getCreateRoomUrl: () => string;
/**
 * @summary Create a room
 */
export declare const createRoom: (createRoomRequest: CreateRoomRequest, options?: Parameters<typeof customFetch>[1]) => Promise<RoomResponse>;
export declare const getCreateRoomMutationKey: () => readonly ["createRoom"];
export declare const getCreateRoomMutationOptions: <TError = ErrorType<void | UnauthorizedResponse>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof createRoom>>, TError, CreateRoomMutationVariables, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof createRoom>>, TError, CreateRoomMutationVariables, TContext>;
export type CreateRoomMutationResult = NonNullable<Awaited<ReturnType<typeof createRoom>>>;
export type CreateRoomMutationBody = BodyType<CreateRoomRequest>;
export type CreateRoomMutationError = ErrorType<void | UnauthorizedResponse>;
export type CreateRoomMutationVariables = {
    data: BodyType<CreateRoomRequest>;
};
/**
* @summary Create a room
*/
export declare const useCreateRoom: <TError = ErrorType<void | UnauthorizedResponse>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof createRoom>>, TError, CreateRoomMutationVariables, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof createRoom>>, TError, CreateRoomMutationVariables, TContext>;
export declare const getGetRoomUrl: (roomId: string) => string;
/**
 * @summary Get room info
 */
export declare const getRoom: (roomId: string, options?: Parameters<typeof customFetch>[1]) => Promise<RoomResponse>;
export declare const getGetRoomQueryKey: (roomId: string) => readonly [`/api/rooms/${string}`];
export declare const getGetRoomQueryOptions: <TData = Awaited<ReturnType<typeof getRoom>>, TError = ErrorType<UnauthorizedResponse | void>>(roomId: string, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getRoom>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getRoom>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetRoomQueryResult = NonNullable<Awaited<ReturnType<typeof getRoom>>>;
export type GetRoomQueryError = ErrorType<UnauthorizedResponse | void>;
/**
 * @summary Get room info
 */
export declare function useGetRoom<TData = Awaited<ReturnType<typeof getRoom>>, TError = ErrorType<UnauthorizedResponse | void>>(roomId: string, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getRoom>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export {};
//# sourceMappingURL=api.d.ts.map