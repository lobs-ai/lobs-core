declare module "shell-quote" {
  export type ControlOperator =
    | "&&"
    | "||"
    | "|"
    | ";"
    | "&"
    | "|&"
    | "<"
    | "<<"
    | "<<-"
    | ">"
    | ">>"
    | "<>"
    | ">&"
    | "<&"
    | ">|"
    | "glob";

  export type ParseEntry =
    | string
    | { op: ControlOperator; pattern?: string }
    | { comment: string };

  export function parse(
    command: string,
    env?: Record<string, string> | ((key: string) => string),
  ): ParseEntry[];
}
