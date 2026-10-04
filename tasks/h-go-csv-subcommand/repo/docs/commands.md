# glean commands

Every command reads one CSV table from FILE, or from standard input when FILE
is missing or `-`, and (except `headers` and `count`) writes CSV to standard
output using the same delimiter as the input.

## Common conventions

**Input flags.** Every command that reads a table accepts:

- `-d DELIM`: field delimiter. A single character, or `tab`, `comma`,
  `semicolon`, `pipe`. Default `,`.
- `-n`: the input has no header row. Columns are then named by their 1-based
  index (`1`, `2`, ...), and commands that copy the header to their output
  don't.

**Column selections.** Flags written `-s COLUMNS` take a comma-separated
list of column names, 1-based indexes, or index ranges (`2-4`, `3-` to the
last column, `-2` from the first). A name made only of digits is an index.
Columns are used in the order listed; repeats are allowed. When `-s` is
optional, leaving it out selects every column.

**Errors and exit status.** Messages go to standard error, prefixed with
`glean <command>: `.

- Exit status 2 for a wrong command line: unknown flags, bad flag values,
  too many arguments, or a column selection that doesn't match the input
  (`unknown column "x"`, `column index 9 out of range (input has 4
  columns)`, ...). The message is followed by a `usage:` line.
- Exit status 1 when the command fails: a file that can't be opened, or
  malformed CSV (`data.csv: line 3: wrong number of fields`).

**Help.** `glean help` lists the commands. `glean help <command>` and
`glean <command> -h` print the usage line and summary.

## glean headers

    glean headers [-d DELIM] [FILE]

Prints each column's 1-based index and name, one per line, aligned.

## glean count

    glean count [-d DELIM] [-n] [FILE]

Prints the number of data rows (the header row is not counted).

## glean select

    glean select -s COLUMNS [-d DELIM] [-n] [FILE]

Writes only the selected columns, in the order given. `-s` is required.

## glean head

    glean head [-l LIMIT] [-d DELIM] [-n] [FILE]

Writes the header and the first LIMIT rows (default 10). `-l 0` writes only
the header. A negative LIMIT is a usage error: `-l must be >= 0, got -1`.

## glean sort

    glean sort [-s COLUMNS] [-N] [-r] [-d DELIM] [-n] [FILE]

Sorts the rows by the selected columns, most significant first. The sort is
stable. `-N` compares numerically (cells that aren't numbers sort after
numbers, as strings); `-r` reverses the order.

## glean filter

    glean filter -e REGEXP [-s COLUMNS] [-v] [-d DELIM] [-n] [FILE]

Keeps the rows where any selected column matches REGEXP (Go `regexp`
syntax, unanchored). `-v` keeps the rows that don't match.

## glean stats

    glean stats [-s COLUMNS] [-d DELIM] [-n] [FILE]

Writes one row per selected column with the header
`field,rows,empty,numeric,min,max,mean`: the column name, the number of
rows, of empty cells and of numeric cells, then the minimum, maximum and
mean of the numeric cells (empty when there are none). The mean is rounded
to 6 decimal places. Numbers are written in the shortest form that reads
back exactly (`3`, `0.25`). The header is written even with `-n`.

## glean uniq

    glean uniq [-s COLUMNS] [-i] [-d DELIM] [-n] [FILE]

Writes each row unless an earlier row had the same values in the selected
columns. `-i` compares case-insensitively. The first occurrence is kept.

## glean rename

    glean rename -r OLD=NEW[,OLD=NEW...] [-d DELIM] [FILE]

Renames columns. Each OLD is a column name or index that selects exactly
one column.

## glean convert

    glean convert -o DELIM [-d DELIM] [-n] [FILE]

Rewrites the table with the output delimiter given by `-o` (same forms as
`-d`).

## glean join

    glean join -k COLUMNS [-K COLUMNS] [-left] [-d DELIM] [-n] LEFT RIGHT

Joins two tables (either may be `-` for standard input). For each LEFT row,
in order, writes one output row per RIGHT row whose `-K` key columns equal
its `-k` key columns (in RIGHT order): the LEFT row followed by the RIGHT
row's other columns. `-K` defaults to `-k`. With `-left`, LEFT rows without
a match are written with empty cells for the RIGHT columns. Both tables use
the same `-d` and `-n`.
