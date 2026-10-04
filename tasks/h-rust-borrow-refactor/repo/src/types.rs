use std::fmt;

pub type OrderId = u64;
/// Price in ticks.
pub type Price = u64;
pub type Qty = u64;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Side {
    Buy,
    Sell,
}

impl Side {
    pub fn opposite(self) -> Side {
        match self {
            Side::Buy => Side::Sell,
            Side::Sell => Side::Buy,
        }
    }

    /// Whether an incoming order on this side with limit `limit` can trade
    /// against a resting order priced at `resting`.
    pub fn crosses(self, limit: Price, resting: Price) -> bool {
        match self {
            Side::Buy => limit >= resting,
            Side::Sell => limit <= resting,
        }
    }
}

/// A resting order. `qty` is the quantity still open.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Order {
    pub id: OrderId,
    pub owner: String,
    pub side: Side,
    pub price: Price,
    pub qty: Qty,
    /// Time priority: lower is earlier. Assigned on entry and again when an
    /// amend increases the quantity.
    pub seq: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fill {
    pub maker: OrderId,
    pub taker: OrderId,
    pub price: Price,
    pub qty: Qty,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SubmitResult {
    pub id: OrderId,
    pub fills: Vec<Fill>,
    /// Quantity left resting on the book after matching (0 if fully filled).
    pub resting: Qty,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BookError {
    ZeroQuantity,
    ZeroPrice,
    UnknownOrder(OrderId),
}

impl fmt::Display for BookError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BookError::ZeroQuantity => write!(f, "quantity must be positive"),
            BookError::ZeroPrice => write!(f, "price must be positive"),
            BookError::UnknownOrder(id) => write!(f, "no resting order with id {id}"),
        }
    }
}

impl std::error::Error for BookError {}
