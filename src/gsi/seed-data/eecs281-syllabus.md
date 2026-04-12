# EECS 281: Data Structures and Algorithms — Course Reference

> University of Michigan, Department of EECS  
> This document summarizes key course policies, topics, and expectations for EECS 281.

---

## Course Overview

EECS 281 is an upper-division undergraduate course covering fundamental data structures and algorithms. Students learn to analyze algorithm complexity, implement standard data structures in C++, and apply them to solve computational problems efficiently.

**Credits:** 4 credit hours  
**Prerequisites:** EECS 280 (Programming and Introductory Data Structures) and Math 465 or equivalent  
**Language:** C++17

---

## Learning Objectives

By the end of the course, students will be able to:

1. Analyze algorithm time and space complexity using Big-O, Big-Ω, and Big-Θ notation
2. Implement and use arrays, linked lists, stacks, queues, trees, heaps, hash tables, and graphs
3. Apply sorting algorithms (insertion sort, merge sort, quicksort, heapsort, counting sort, radix sort)
4. Implement and use standard graph algorithms (BFS, DFS, Dijkstra's, Prim's, Kruskal's, topological sort)
5. Understand dynamic programming principles and apply them to optimization problems
6. Use C++ STL containers (vector, deque, list, map, unordered_map, set, priority_queue) effectively
7. Write clean, well-documented, memory-safe C++ code

---

## Grading Breakdown

| Component | Weight |
|-----------|--------|
| Programming Projects (4–5) | 40% |
| Homework Problem Sets | 15% |
| Lab Sections (attendance + exercises) | 5% |
| Midterm Exam | 20% |
| Final Exam | 20% |

### Grade Scale
- A+: 97–100%, A: 93–96%, A−: 90–92%
- B+: 87–89%, B: 83–86%, B−: 80–82%
- C+: 77–79%, C: 73–76%, C−: 70–72%
- D+: 67–69%, D: 60–66%
- F: below 60%

### Late Policy
- Projects: **10% penalty per day late** (up to 3 days; no submissions accepted after 3 days)
- Homework: **50% penalty if submitted within 24 hours late; not accepted after 24 hours**
- To receive any credit, late work must be submitted before solutions are posted

---

## Programming Projects

All projects are completed individually. Collaboration policy: you may discuss concepts with classmates but all code must be your own.

### Project 1: Sorting Algorithms
Implement comparison-based sorting (insertion sort, merge sort, quicksort) and analyze their performance experimentally. Understand best/average/worst-case complexity.

### Project 2: Stack and Queue Applications
Use stack and queue to solve a navigation/routing problem (e.g., maze solving with DFS via stack or BFS via queue). Compare approaches.

### Project 3: Binary Search Trees / Priority Queue
Implement a BST or binary heap. Use to solve a scheduling or priority-based problem. Understand heap operations: insert, extract-min/max, heapify.

### Project 4: Hash Tables
Implement a hash table with chaining and/or open addressing. Handle collisions, analyze load factor and performance degradation.

### Project 5 (some semesters): Graphs
Implement graph representations (adjacency list, adjacency matrix). Apply BFS, DFS, and at least one shortest-path algorithm (Dijkstra's or Bellman-Ford).

---

## Course Topics by Week

### Week 1–2: Foundations
- Algorithm analysis: Big-O, Big-Ω, Big-Θ notation
- Recurrence relations and Master Theorem
- C++ review: templates, STL iterators, memory management
- Review of EECS 280 concepts

### Week 3–4: Sorting
- Comparison sorts: insertion sort O(n²), merge sort O(n log n), quicksort O(n log n) average
- Lower bound proof: Ω(n log n) for comparison sorts
- Non-comparison sorts: counting sort O(n+k), radix sort O(d(n+k))
- STL: std::sort, std::stable_sort

### Week 5–6: Stacks, Queues, and Deques
- Stack (LIFO): push/pop O(1) — backed by std::deque
- Queue (FIFO): enqueue/dequeue O(1)
- Deque (double-ended queue): O(1) push/pop front and back
- Applications: infix/postfix expression evaluation, BFS/DFS, call stack simulation
- STL: std::stack, std::queue, std::deque

### Week 7–8: Trees and Binary Search Trees
- Binary tree terminology: root, leaf, height, depth, subtree
- Binary Search Tree property: left subtree < root < right subtree
- BST operations: search O(h), insert O(h), delete O(h) — h = height
- Balanced BSTs: AVL trees (brief), Red-Black trees (brief)
- STL: std::map and std::set are typically Red-Black trees — O(log n) ops
- Tree traversals: inorder (sorted), preorder, postorder, level-order (BFS)

### Week 9: Heaps and Priority Queues
- Binary heap: complete binary tree stored in array
- Min-heap property: parent ≤ children; Max-heap: parent ≥ children
- Heap operations:
  - insert: O(log n) — sift up
  - extract-min/max: O(log n) — sift down
  - peek: O(1)
  - build-heap: O(n) — heapify all internal nodes bottom-up
- Heapsort: O(n log n) in-place sort using heap
- STL: std::priority_queue (max-heap by default; use greater<T> for min-heap)
- D-ary heaps: generalization with d children per node

### Week 10: Hash Tables
- Hash function: maps key → [0, N-1]
- Collision resolution strategies:
  - Chaining (separate chaining): O(1) average, O(n) worst
  - Open addressing: linear probing, quadratic probing, double hashing
- Load factor α = n/N: keep α < 0.7 for open addressing
- Dynamic resizing: rehash when load factor exceeds threshold
- Good hash functions: polynomial rolling hash for strings
- STL: std::unordered_map / std::unordered_set — O(1) average; std::map — O(log n)

### Week 11–12: Graphs
- Graph representations:
  - Adjacency matrix: O(V²) space, O(1) edge lookup
  - Adjacency list: O(V+E) space, O(degree) neighbor iteration
- Graph traversals:
  - BFS (Breadth-First Search): uses queue, finds shortest path in unweighted graphs, O(V+E)
  - DFS (Depth-First Search): uses stack/recursion, finds connected components, O(V+E)
- Topological sort: ordering of DAG vertices (Kahn's algorithm or DFS-based)
- Shortest paths:
  - Dijkstra's algorithm: non-negative weights, O((V+E) log V) with priority queue
  - Bellman-Ford: handles negative weights, O(VE)
  - Floyd-Warshall: all-pairs shortest paths, O(V³)
- Minimum Spanning Tree (MST):
  - Prim's algorithm: greedy, O((V+E) log V)
  - Kruskal's algorithm: sort edges + Union-Find, O(E log E)

### Week 13: Dynamic Programming
- Key insight: overlapping subproblems + optimal substructure
- Memoization (top-down) vs. tabulation (bottom-up)
- Classic problems:
  - Fibonacci: O(n) with memoization vs O(2^n) naive
  - Longest Common Subsequence (LCS): O(nm) time and space
  - Knapsack (0/1): O(nW) pseudo-polynomial
  - Coin change: minimum coins to make amount
  - Longest Increasing Subsequence (LIS): O(n²) DP, O(n log n) with patience sorting
- Distinguishing DP from greedy: DP requires trying all subproblems; greedy makes locally optimal choices

### Week 14: Advanced Topics & Review
- Amortized analysis: aggregate method, potential method
- Disjoint sets (Union-Find): union by rank + path compression → near O(1) per op (inverse Ackermann)
- Space complexity analysis
- NP-completeness overview (P vs NP, reductions)
- Review for final exam

---

## Key C++ Concepts and STL Reference

### Vectors
```cpp
std::vector<int> v;
v.push_back(x);    // O(1) amortized
v.pop_back();      // O(1)
v[i];              // O(1) random access
v.size();          // O(1)
```

### Maps (Ordered)
```cpp
std::map<string, int> m;
m["key"] = value;  // O(log n) insert/update
m.find("key");     // O(log n)
m.count("key");    // O(log n) — 0 or 1
```

### Unordered Maps (Hash)
```cpp
std::unordered_map<string, int> um;
um["key"] = value; // O(1) average
um.find("key");    // O(1) average
```

### Priority Queue
```cpp
// Max-heap (default)
std::priority_queue<int> maxpq;
// Min-heap
std::priority_queue<int, std::vector<int>, std::greater<int>> minpq;
maxpq.push(x);     // O(log n)
maxpq.top();       // O(1) — peek
maxpq.pop();       // O(log n)
```

### Sort
```cpp
std::sort(v.begin(), v.end());            // O(n log n)
std::sort(v.begin(), v.end(), cmp);       // custom comparator
std::stable_sort(v.begin(), v.end());     // preserves equal element order
```

---

## Academic Integrity

EECS 281 takes academic integrity seriously. **All programming projects must be your own individual work.**

### What is allowed:
- Discussing high-level algorithm concepts with classmates
- Using course-provided code skeletons and starter files
- Referring to lecture notes, textbook, and course-approved resources
- Getting help from GSIs/IAs during office hours on conceptual questions

### What is NOT allowed:
- Sharing or copying any portion of project code
- Posting project code to public repositories (GitHub, etc.) during the semester
- Using code from previous semesters, online solutions, or AI code generators on projects
- Submitting work that is not your own

### Consequences:
Violations are reported to the Engineering Honor Council. Penalties range from a 0 on the assignment to course failure and academic probation.

---

## Extensions and Accommodations

- **Extensions**: Submit a request via the course portal **before** the deadline. Extensions are not guaranteed and are typically granted only for documented medical/personal emergencies.
- **SSD accommodations**: Must be registered with the Services for Students with Disabilities (SSD) office. Exam accommodations require notification to the instructor at least 1 week before the exam.
- **Regrades**: Submit regrade requests via Gradescope within **1 week** of grades being released. Include a specific explanation of the grading error.

---

## Office Hours and Resources

- **GSI/IA Office Hours**: Schedule posted on the course website. Typically 20+ hours/week between GSIs and IAs.
- **Piazza**: Primary Q&A platform. Questions answered by GSIs and instructors. Check Piazza before asking — your question may already be answered.
- **Discord**: Unofficial student server for casual discussion and study groups.
- **Textbooks**:
  - *Introduction to Algorithms* (CLRS) — Cormen, Leiserson, Rivest, Stein (primary reference)
  - *Data Structures and Algorithm Analysis in C++* — Mark Allen Weiss
  - *The C++ Programming Language* — Bjarne Stroustrup
- **Autograder**: Projects submitted via the course autograder (eecs281.org or Canvas). You have unlimited submissions before the deadline.

---

## Exam Information

### Midterm
- Covers Weeks 1–8 (sorting, stacks, queues, trees, BSTs)
- Format: written exam, closed-book, one double-sided cheat sheet allowed
- Duration: 80 minutes
- Topics: algorithm analysis, sorting complexity, BST operations, tree traversals, heap operations

### Final
- Cumulative with emphasis on second-half material
- Format: written exam, closed-book, two double-sided cheat sheets allowed
- Duration: 120 minutes
- Topics: all above plus hash tables, graphs (BFS/DFS/Dijkstra/MST), dynamic programming

### Exam Tips
- Practice complexity analysis: know the Big-O for every operation of every data structure
- Trace through algorithms by hand on small examples
- Know the difference between when to use each data structure
- Understand amortized analysis (especially for std::vector push_back)

---

## Common Student Questions

**Q: When should I use unordered_map vs map?**  
Use `unordered_map` when you need O(1) average lookups and don't need ordered iteration. Use `map` when you need sorted order, or when keys don't have a good hash function. Note that `unordered_map` can have O(n) worst-case due to hash collisions.

**Q: How do I pick a pivot for quicksort?**  
Common strategies: random pivot (best in practice), median-of-three (first/middle/last elements). Avoid always picking first or last element — degrades to O(n²) on sorted input.

**Q: What's the difference between BFS and DFS?**  
BFS uses a queue and explores level by level — finds shortest path in unweighted graphs. DFS uses a stack (or recursion) and goes as deep as possible before backtracking — useful for cycle detection, topological sort, connected components.

**Q: How does Dijkstra's algorithm handle negative edges?**  
It doesn't — Dijkstra's requires all edge weights to be non-negative. For graphs with negative weights, use Bellman-Ford. For graphs with negative cycles, there is no well-defined shortest path.

**Q: What's the best way to study for exams?**  
Practice writing algorithms by hand without an IDE. Do past exam problems. Make sure you can trace through BFS/DFS/Dijkstra/heapify on small graphs. Know the complexity table cold.

---

## Complexity Quick Reference

| Data Structure | Access | Search | Insert | Delete |
|---------------|--------|--------|--------|--------|
| Array | O(1) | O(n) | O(n) | O(n) |
| Linked List | O(n) | O(n) | O(1)† | O(1)† |
| Stack/Queue | — | — | O(1) | O(1) |
| BST (balanced) | — | O(log n) | O(log n) | O(log n) |
| Hash Table | — | O(1) avg | O(1) avg | O(1) avg |
| Min/Max Heap | O(1) peek | — | O(log n) | O(log n) |

†Given pointer to position.

| Algorithm | Best | Average | Worst | Space |
|-----------|------|---------|-------|-------|
| Insertion Sort | O(n) | O(n²) | O(n²) | O(1) |
| Merge Sort | O(n log n) | O(n log n) | O(n log n) | O(n) |
| Quicksort | O(n log n) | O(n log n) | O(n²) | O(log n) |
| Heapsort | O(n log n) | O(n log n) | O(n log n) | O(1) |
| BFS / DFS | — | O(V+E) | O(V+E) | O(V) |
| Dijkstra's | — | O((V+E)log V) | O((V+E)log V) | O(V) |
| Prim's MST | — | O((V+E)log V) | O((V+E)log V) | O(V) |
