//! Renders tables of text as ASCII art for terminal output.
//!
//! ```
//! use texttable::{Align, Table};
//!
//! let mut t = Table::new(&["Name", "Qty"]);
//! t.align(1, Align::Right);
//! t.add_row(&["apples", "3"]).unwrap();
//! print!("{}", t.render());
//! ```

mod error;

pub use error::TableError;

/// Horizontal alignment of a column.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Align {
    Left,
    Right,
    Center,
}

/// A table with a fixed set of columns.
#[derive(Debug, Clone)]
pub struct Table {
    headers: Vec<String>,
    rows: Vec<Vec<String>>,
    align: Vec<Option<Align>>,
    max_width: Vec<Option<usize>>,
    separate_rows: bool,
}

impl Table {
    /// Creates a table whose columns have the given headers.
    pub fn new(headers: &[&str]) -> Table {
        Table {
            headers: headers.iter().map(|h| h.to_string()).collect(),
            rows: Vec::new(),
            align: vec![None; headers.len()],
            max_width: vec![None; headers.len()],
            separate_rows: false,
        }
    }

    /// Number of columns.
    pub fn columns(&self) -> usize {
        self.headers.len()
    }

    /// Sets the alignment of column `col`.
    pub fn align(&mut self, col: usize, align: Align) -> &mut Self {
        self.align[col] = Some(align);
        self
    }

    /// Limits the display width of column `col`.
    pub fn max_width(&mut self, col: usize, width: usize) -> &mut Self {
        self.max_width[col] = Some(width);
        self
    }

    /// Draws a separator line between body rows.
    pub fn separate_rows(&mut self, on: bool) -> &mut Self {
        self.separate_rows = on;
        self
    }

    /// Appends a row.
    pub fn add_row(&mut self, cells: &[&str]) -> Result<(), TableError> {
        if cells.len() > self.headers.len() {
            return Err(TableError::TooManyCells {
                row: self.rows.len(),
                expected: self.headers.len(),
                got: cells.len(),
            });
        }
        self.rows.push(cells.iter().map(|c| c.to_string()).collect());
        Ok(())
    }

    /// Renders the table.
    pub fn render(&self) -> String {
        let n = self.headers.len();
        let mut widths: Vec<usize> = self.headers.iter().map(|h| h.len()).collect();
        for row in &self.rows {
            for (i, cell) in row.iter().enumerate() {
                widths[i] = widths[i].max(cell.len());
            }
        }

        let border = |fill: char| {
            let mut s = String::from("+");
            for w in &widths {
                s.extend(std::iter::repeat(fill).take(w + 2));
                s.push('+');
            }
            s.push('\n');
            s
        };
        let line = |cells: &[String]| {
            let mut s = String::from("|");
            for i in 0..n {
                let cell = &cells[i];
                let pad = widths[i] - cell.len();
                s.push(' ');
                match self.align[i].unwrap_or(Align::Left) {
                    Align::Right => {
                        s.push_str(&" ".repeat(pad));
                        s.push_str(cell);
                    }
                    _ => {
                        s.push_str(cell);
                        s.push_str(&" ".repeat(pad));
                    }
                }
                s.push_str(" |");
            }
            s.push('\n');
            s
        };

        let mut out = border('-');
        out.push_str(&line(&self.headers));
        out.push_str(&border('='));
        for row in &self.rows {
            out.push_str(&line(row));
        }
        out.push_str(&border('-'));
        out
    }
}
