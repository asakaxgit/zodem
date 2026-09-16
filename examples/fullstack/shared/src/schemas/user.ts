import { z } from "zod";
import { zodem } from "@zodem/core";

// Shared instances so User and CreateUserRequest reference the same nested
// Role enum / Address message instead of each growing their own copy.
const RoleEnum = z.enum(["admin", "member"]);

export const Address = zodem.message("acme.user.v1.Address", {
  city: z.string().min(1),
  country: z.string().length(2),
});

export const User = zodem.message("acme.user.v1.User", {
  id: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string().min(1).max(100),
  age: z.number().int().min(0).max(150).meta({ proto: "int32" }),
  role: RoleEnum,
  nickname: z.string().nullable(),
  address: Address,
  createdAt: z.date(),
});

export const CreateUserRequest = zodem.message("acme.user.v1.CreateUserRequest", {
  email: z.string().email(),
  displayName: z.string().min(1).max(100),
  age: z.number().int().min(0).max(150).meta({ proto: "int32" }),
  role: RoleEnum,
  nickname: z.string().nullable(),
  address: Address,
});

export const CreateUserResponse = zodem.message("acme.user.v1.CreateUserResponse", {
  user: User,
});

export const GetUserRequest = zodem.message("acme.user.v1.GetUserRequest", {
  id: z.string().uuid(),
});

export const GetUserResponse = zodem.message("acme.user.v1.GetUserResponse", {
  user: User,
});

export const UserService = zodem.service("acme.user.v1.UserService", {
  createUser: { input: CreateUserRequest, output: CreateUserResponse },
  getUser: { input: GetUserRequest, output: GetUserResponse },
});
