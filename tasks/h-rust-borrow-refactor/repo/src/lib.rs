//! A single-instrument limit order book with price-time priority.

mod book;
mod levels;
mod matching;
mod report;
pub mod types;

pub use book::OrderBook;
pub use report::Level;
pub use types::{BookError, Fill, Order, OrderId, Price, Qty, Side, SubmitResult};
