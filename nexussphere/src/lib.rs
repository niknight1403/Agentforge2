use serde::{Deserialize,Serialize};
#[derive(Clone,Debug,Serialize,Deserialize,PartialEq)] pub struct Node{pub id:String,pub healthy:bool,pub load:u8}
pub fn select_node(nodes:&[Node])->Option<&Node>{nodes.iter().filter(|n|n.healthy).min_by_key(|n|n.load)}
#[cfg(test)] mod tests{use super::*;#[test]fn chooses_lowest_healthy(){let n=vec![Node{id:"a".into(),healthy:true,load:80},Node{id:"b".into(),healthy:true,load:20},Node{id:"c".into(),healthy:false,load:1}];assert_eq!(select_node(&n).unwrap().id,"b");}#[test]fn none_without_healthy(){assert!(select_node(&[Node{id:"x".into(),healthy:false,load:0}]).is_none());}}
