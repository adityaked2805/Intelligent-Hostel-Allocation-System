# Intelligent Hostel Allocation System

An automated, intelligent hostel room allocation system built with NestJS (core services), React (frontend), and Python (allocation engine).

## 🏗️ Architecture

The system follows a microservices architecture:

- **Core Services (NestJS)** - Authentication, user management, hostel/room management ([API Docs](http://localhost:3000/api/docs))
- **Frontend (React + React Router 7)** - Student and warden dashboards
- **Allocation Engine (Python + FastAPI)** - CSP + Bin Packing algorithm for smart allocation

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- Python 3.10+
- Docker & Docker Compose
- PostgreSQL (or use Docker)

### 1. Start the Database

```bash
# Using existing PostgreSQL or:
docker compose up -d
```

### 2. Start Core Services (NestJS)

```bash
cd core-services
npm install
npm run start:dev
```

The API will be available at:

- API: <http://localhost:3000>
- Swagger Docs: <http://localhost:3000/api/docs>

### 3. Start Frontend (React)

```bash
cd frontend
npm install
npm run dev
```

Frontend available at: <http://localhost:5173> (or 5174)

### 4. Start Allocation Engine (Python)

```bash
cd allocation-engine
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python -m app.main
```

Allocation API at: <http://localhost:8000>

## 📁 Project Structure

```text
├── core-services/          # NestJS backend
│   ├── src/
│   │   ├── auth/          # Authentication module
│   │   ├── students/      # Student management
│   │   └── entities/      # TypeORM entities
│   └── ...
├── frontend/              # React frontend
│   ├── app/
│   │   ├── routes/        # Page components
│   │   ├── components/    # Reusable UI components
│   │   └── lib/           # API client & stores
│   └── ...
├── allocation-engine/     # Python allocation service
│   ├── app/
│   │   ├── allocation.py  # CSP + Bin Packing algorithm
│   │   └── main.py        # FastAPI server
│   └── ...
└── docker-compose.yml     # PostgreSQL setup
```

## 🔑 Features

### For Students

- Register/login with JWT auth
- Manage profile (roll number, year, gender, program)
- Create one group and invite by roll number
- Consent-based invitation flow (`pending`/`accepted`/`declined`)
- View and respond to swap requests

### For Wardens/Admin

- Manage hostels, wings, floors, and rooms
- Bulk room creation for faster setup
- Configure allocation rules (year, room type, priority, allow/deny)
- Run allocation in two modes: `group_based` and `fcfs`
- Review allocation history and per-run results
- View swap cycles and execute chain swaps

### Allocation Intelligence

- Two-stage allocation (CSP + First-Fit Decreasing bin packing)
- Gender-aware and rule-aware room eligibility filtering
- Group split fallback with proximity scoring
- Per-student happiness score in allocation results
- Allocation decision audit trail (`availableRooms`, `constraintsApplied`, `alternativesConsidered`)


## 🧮 Allocation Algorithm

The system uses a two-stage hybrid algorithm:

1. **Stage 1: Constraint Satisfaction Problem (CSP)**
   - Filters valid room assignments based on rules
   - Uses python-constraint library

2. **Stage 2: Bin Packing (First-Fit Decreasing)**
   - Groups are "items", wings are "bins"
   - Maximizes group cohesion
   - Larger groups placed first

## 📚 API Documentation

Access Swagger UI at <http://localhost:3000/api/docs> for interactive API documentation.

### Key Endpoints

**Authentication:**

- `POST /auth/register` - Register new user
- `POST /auth/login` - Login
- `GET /auth/profile` - Get current user profile

**Students:**

- `GET /students` - List all students
- `GET /students/roll/:rollNumber` - Find by roll number

## 🛠️ Development

### Environment Variables

Core Services (`.env`):

```env
DB_HOST=localhost
DB_PORT=5433
DB_USERNAME=postgres
DB_PASSWORD=postgres
DB_DATABASE=hostel_allocation
JWT_SECRET=your-secret-key
JWT_EXPIRATION=7d
```

```sql
hasSubmitted BOOLEAN NOT NULL DEFAULT FALSE;
applicationStatus VARCHAR NOT NULL DEFAULT 'NONE';
```

Purpose:

- `hasSubmitted` controls whether the student is included in allocation
- `applicationStatus` tracks the current phase of the student's request

Example values:

```text
NONE
PENDING
UPGRADE_REQUESTED
WAITLISTED
```

### AllocationRun Entity

Added:

```text
targetYears INTEGER[]
targetPrograms TEXT[]
```

Purpose:

- Tracks which cohort was targeted in the allocation run
- Enables selective reset of only those students after commit

Example:

```json
{
  "targetYears": [1, 4],
  "targetPrograms": ["CSE", "ECE"]
}
```

### AllocationRule Entity

Added:

```text
wingName VARCHAR NULL
```

This extends rule targeting from hostel level to hostel + wing level.

Example:

```text
Hostel: BH1
Wing: E
Year: 1
Allowed: true
Priority: 100
```

This enables:

- Wing E reserved for first-year students
- Wings A/B reserved for fourth-year students
- Fine-grained co-ed / mixed building policies

### AdministrativeAction Entity (New)

A new table was added:

```text
administrative_actions
```

Schema:

```text
id UUID PRIMARY KEY
actionType ENUM('EVICTION', 'ALLOCATION_COMMIT')
performedBy UUID
timestamp TIMESTAMPTZ
snapshot JSONB
```

Example snapshot:

```json
{
  "student_101": "room_12",
  "student_102": "room_13"
}
```

Purpose:

- Stores the exact student → room mapping before a major admin action
- Enables rollback of evictions and commits

---

## 3. Backend Changes (NestJS)

### Allocation Commit Enhancements

The `publishAndCommitRun` flow was redesigned.

New behavior:

1. Before commit, capture the current room state of all affected students
2. Save the snapshot into `AdministrativeAction`
3. Commit all room changes inside one SQL transaction
4. Update old room status to `AVAILABLE`
5. Update new room status to `OCCUPIED`
6. Reset targeted students after successful commit

Example reset logic:

```ts
student.hasSubmitted = false;
student.applicationStatus = 'NONE';
```

### Bulk Eviction Enhancements

`bulkEvictStudents` now:

- Captures a rollback snapshot before eviction
- Clears student room assignments
- Resets `hasSubmitted = false`
- Stores the action in `AdministrativeAction`

### Rollback API

New rollback support added.

Endpoint:

```text
POST /admin/actions/:id/rollback
```

Behavior:

- Loads snapshot JSON from `AdministrativeAction`
- Restores student room assignments
- Fixes room statuses automatically
- Executes everything transactionally

### Reset Application Status Endpoint

New endpoint:

```text
POST /admin/allocation/reset-status
```

Optional request:

```json
{
  "year": 2
}
```

Purpose:

- Allows wardens to reopen allocation for a specific year

### Allocation Draft Deletion

New endpoint:

```text
DELETE /admin/allocation/runs/:id
```

Purpose:

- Delete failed / unfinished allocation runs
- Prevent admins from getting stuck with invalid drafts

---

## 4. Rules Matrix System

The old flat rule list has been replaced with a hierarchical eligibility matrix.

Structure:

```json
{
  "BH1": {
    "_all": {
      "1": true,
      "2": false,
      "3": false,
      "4": true
    },
    "wings": {
      "A": {
        "4": true
      },
      "B": {
        "4": true
      },
      "E": {
        "1": true
      }
    }
  }
}
```

Backend translation strategy:

1. Delete all previous rules
2. Traverse the matrix
3. Generate new `AllocationRule` rows
4. Automatically assign priorities

This ensures there are no stale or conflicting rules.

---

## 5. Allocation Engine Changes (Python)

### Highest Priority Wins

The engine previously allowed lower-priority rules to override higher-priority rules.

Example problem:

```text
Priority 100 → Allow BH1 Wing A for 4th year
Priority 10  → Deny BH1 entirely
```

The lower-priority deny incorrectly won.

Now:

1. Collect all matching rules
2. Sort descending by priority
3. Evaluate only the first rule
4. Immediately return its decision

Pseudo-code:

```python
rules = sorted(matching_rules, key=lambda r: r.priority, reverse=True)

for rule in rules:
    return rule.is_allowed
```

### Relocatable Student Logic

Students with existing rooms can now still participate in allocation.

Input example:

```json
{
  "studentId": 42,
  "currentRoomId": 15,
  "relocatable_from": 15
}
```

Engine behavior:

- Temporarily marks room 15 as available
- Searches for a better room
- Only moves student if a higher-priority room exists
- Otherwise automatically restores original room

This prevents accidental displacement.

---

## ✨ Key System Features (Summary)

## Updated Features

### Full Student Features

- Register/login with JWT auth
- Manage profile (roll number, year, gender, program)
- Create and manage groups
- Invite students with consent-based workflow
- Submit new applications even after already having a room
- Participate in rolling allocation cycles
- Receive reset eligibility after warden approval
- View and respond to swap requests

### Full Administrative Features

- Manage hostels, wings, floors, and rooms
- Configure eligibility using Rules Matrix UI
- Run allocations in `group_based` or `fcfs`
- Commit allocations directly to live room assignments
- Reset application status by year/program
- Delete failed draft runs
- View rollback logs
- Revert accidental commits/evictions
- Automatically update room statuses during swaps/upgrades

### Core Allocation Algorithm

- Two-stage CSP + Bin Packing algorithm
- Highest-priority-wins rule engine
- Wing-level hostel rules
- Smart relocation support
- Rollback-safe allocation commits
- Group cohesion optimization
- Automatic fallback to previous room if no better room exists

## Dynamic Allocation Flow

```text
Student already has a room
        ↓
Student submits upgrade request
        ↓
hasSubmitted = true
        ↓
Student is included in allocation again
        ↓
Current room becomes temporarily available
        ↓
If better room found → move student
Else → keep original room
```

## New API Endpoints

### Allocation Endpoints

```text
POST   /admin/allocation/run
POST   /admin/allocation/commit/:runId
DELETE /admin/allocation/runs/:id
POST   /admin/allocation/reset-status
POST   /admin/actions/:id/rollback
```

### Rules Matrix Endpoints

```text
GET  /admin/rules/matrix
POST /admin/rules/matrix
```

## Example Rules Matrix Payload

```json
{
  "BH1": {
    "_all": {
      "1": true,
      "2": false,
      "3": false,
      "4": true
    },
    "wings": {
      "A": {
        "4": true
      },
      "B": {
        "4": true
      },
      "E": {
        "1": true
      }
    }
  }
}
```

## Delivery Status (March 2026)

### Completed

- Authentication and profile management
- Consent-based groups
- Rules Matrix UI
- Wing-level allocation rules
- Smart relocation / upgrade logic
- Rolling allocation cycles
- Allocation commit + room status synchronization
- Bulk eviction + rollback
- Delete draft runs
- System logs and rollback history
- Dashboard unlock using `hasSubmitted`
- **Student Eligibility Transparency** toggle to hide/show eligibility in student dashboard

### Partially Complete

- Notification microservice
- RabbitMQ integration
- Redis caching
- Drag-and-drop override UI

### Not Started

- Maintenance request module
- Communication hub
- Payments integration
- Inventory management
- AI analytics

Estimated MVP completion: **~90%**

Estimated long-term roadmap completion: **~58%**

## 📄 License

MIT License
This is the official hostel allocation for LNMIIT
