import { z } from "zod";

const text = z.string().trim().min(1);
const currency = text.toUpperCase().regex(/^[A-Z]{3}$/).refine(
    value => Intl.supportedValuesOf("currency").includes(value),
    "Provide a supported ISO 4217 currency code."
);

export const jobFields = {
    title: text,
    description: text,
    experience: text,
    city: text.nullable().optional(),
    state: text.nullable().optional(),
    country: text.nullable().optional(),
    skills: z.array(text).optional(),
    employment_type: text.nullable().optional(),
    job_type: text.nullable().optional(),
    industry: text.nullable().optional(),
    education_level: text.nullable().optional(),
    salary_value: z.number().finite().nonnegative().nullable().optional(),
    salary_currency: currency.nullable().optional(),
    searchable: z.boolean().optional(),
    applyable: z.boolean().optional()
};

// Validate again at the storage boundary (including seed/import scripts).
export const storedJobSchema = z.object(jobFields).strict();
export const updatesSchema = storedJobSchema.partial().extend({
    experience: text.nullable().optional()
}).refine(updates => Object.values(updates).some(value => value !== undefined),
    "Provide at least one field to update.");

export function creationSchema(env = process.env) {
    const defaults = z.object({
        employment_type: text.optional(),
        job_type: text.optional(),
        salary_currency: currency.optional()
    }).parse({
        employment_type: env.DEFAULT_EMPLOYMENT_TYPE,
        job_type: env.DEFAULT_JOB_TYPE,
        salary_currency: env.DEFAULT_SALARY_CURRENCY
    });
    const fields = {
        title: text.describe("Required job title. Ask only if missing."),
        experience: text.describe("Required experience level. Ask only if missing."),
        description: text.optional().describe("Generate a description from supplied facts if missing; do not invent benefits or requirements."),
        city: text.optional(), state: text.optional(), country: text.optional(),
        skills: z.array(text).optional(),
        industry: text.optional(), education_level: text.optional(),
        salary_value: z.number().finite().nonnegative().optional()
    };
    for (const key of ["employment_type", "job_type", "salary_currency"]) {
        const schema = key === "salary_currency" ? currency : text;
        fields[key] = defaults[key] === undefined ? schema.optional() : schema.default(defaults[key]);
    }
    return z.object(fields).strict();
}
