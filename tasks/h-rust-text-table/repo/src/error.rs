use std::fmt;

/// Errors returned when building a table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TableError {
    /// A row had more cells than the table has columns. `row` is the 0-based
    /// index the row would have had.
    TooManyCells { row: usize, expected: usize, got: usize },
}

impl fmt::Display for TableError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TableError::TooManyCells { row, expected, got } => {
                write!(f, "row {row}: expected at most {expected} cells, got {got}")
            }
        }
    }
}

impl std::error::Error for TableError {}
