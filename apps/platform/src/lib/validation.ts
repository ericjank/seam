import { z } from "zod";

export const optionalUuid = z.preprocess((value) => value === "" ? undefined : value, z.string().uuid().optional());
export const optionalDateTime = z.preprocess((value) => value === "" ? undefined : value, z.string().datetime().optional());
