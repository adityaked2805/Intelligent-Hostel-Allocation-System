from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
import httpx
import uuid
from typing import Dict, Any

from .config import get_settings
from .models import AllocationRequest, AllocationResponse, AllocationResult
from .allocation import AllocationEngine

settings = get_settings()

app = FastAPI(
    title="Hostel Allocation Engine",
    description="Python-based intelligent hostel room allocation using CSP + Bin Packing",
    version="1.0.0"
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:5173", "http://localhost:5174"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory storage for allocation runs (in production, use database)
allocation_runs: Dict[str, Dict[str, Any]] = {}


@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "healthy", "service": "allocation-engine"}


async def fetch_data_from_core_services():
    """Fetch students, groups, hostels, and rooms from core services"""
    async with httpx.AsyncClient() as client:
        try:
            # Fetch data from the core services API
            response = await client.get(
                f"{settings.core_services_url}/allocation-data",
                timeout=30.0
            )
            response.raise_for_status()
            data = response.json()

            # Transform the data to match the expected format
            from .models import Student, Group, Hostel, Room, GenderType, RoomStatus, RoommateInvitation

            students = [
                Student(
                    user_id=s['userId'],
                    roll_number=s['rollNumber'],
                    full_name=s['fullName'],
                    year=s['year'],
                    gender=GenderType(s.get('gender', 'male')),
                    program=s.get('program'),
                    application_timestamp=s.get('applicationTimestamp'),
                    current_room_id=s.get('currentRoomId')
                )
                for s in data.get('students', [])
            ]

            groups = [
                Group(
                    id=g['id'],
                    name=g['name'],
                    creator_id=g['creatorId'],
                    members=[
                        Student(
                            user_id=m['userId'],
                            roll_number=m['rollNumber'],
                            full_name=m['fullName'],
                            year=m['year'],
                            gender=GenderType(m.get('gender', 'male')),
                            program=m.get('program'),
                            application_timestamp=m.get('applicationTimestamp'),
                            current_room_id=m.get('currentRoomId')
                        )
                        for m in g.get('members', [])
                    ]
                )
                for g in data.get('groups', [])
            ]

            hostels = [
                Hostel(
                    id=h['id'],
                    name=h['name'],
                    gender_type=GenderType(h['genderType'])
                )
                for h in data.get('hostels', [])
            ]

            rooms = [
                Room(
                    id=r['id'],
                    hostel_id=r['hostelId'],
                    room_number=r['roomNumber'],
                    floor=r.get('floor'),
                    wing=r.get('wing'),
                    capacity=r['capacity'],
                    room_type=r.get('roomType', 'double'),
                    status=RoomStatus(r.get('status', 'available'))
                )
                for r in data.get('rooms', [])
            ]

            roommate_invitations = [
                RoommateInvitation(
                    id=ri['id'],
                    sender_id=ri['senderId'],
                    receiver_id=ri['receiverId'],
                    group_id=ri['groupId'],
                    status=ri.get('status', 'accepted')
                )
                for ri in data.get('roommateInvitations', [])
            ]

            return {
                "students": students,
                "groups": groups,
                "hostels": hostels,
                "rooms": rooms,
                "roommate_invitations": roommate_invitations
            }
        except httpx.RequestError as e:
            raise HTTPException(status_code=503, detail=f"Core services unavailable: {str(e)}")
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to process data: {str(e)}")


async def run_allocation_task(run_id: str, request: AllocationRequest):
    """Background task to run allocation"""
    try:
        allocation_runs[run_id]["status"] = "running"

        # Fetch data from core services
        data = await fetch_data_from_core_services()

        # Apply cohort filters (empty list = no filter, allocate everyone)
        filtered_students = data["students"]
        if request.target_years:
            filtered_students = [s for s in filtered_students if s.year in request.target_years]
        if request.target_programs:
            filtered_students = [s for s in filtered_students if s.program in request.target_programs]

        # Create engine and run allocation
        engine = AllocationEngine(
            students=filtered_students,
            groups=data["groups"],
            hostels=data["hostels"],
            rooms=data["rooms"],
            rules=request.rules,
            roommate_invitations=data["roommate_invitations"],
            locked_assignments=request.locked_assignments,
        )

        results = engine.run_allocation(mode=request.allocation_mode)

        allocation_runs[run_id].update({
            "status": "completed",
            "results": results,
            "decision_logs": engine.decision_logs,
            "total_students": len(filtered_students),
            "allocated_students": len([r for r in results if r.room_id is not None])
        })
        
    except Exception as e:
        import traceback
        error_msg = f"Error in run_allocation_task: {str(e)}\n{traceback.format_exc()}"
        print(error_msg)
        with open("engine_error.log", "a") as f:
            f.write(error_msg + "\n")
        
        allocation_runs[run_id].update({
            "status": "failed",
            "error": str(e)
        })


@app.post("/allocate", response_model=dict)
async def trigger_allocation(request: AllocationRequest, background_tasks: BackgroundTasks):
    """
    Trigger a new allocation run
    
    This endpoint starts the allocation process in the background
    and returns a run_id to check the status
    """
    run_id = request.allocation_run_id or str(uuid.uuid4())
    
    allocation_runs[run_id] = {
        "status": "queued",
        "results": [],
        "decision_logs": [],
        "total_students": 0,
        "allocated_students": 0
    }
    
    # Run allocation in background
    background_tasks.add_task(
        run_allocation_task,
        run_id,
        request
    )
    
    return {
        "run_id": run_id,
        "status": "queued",
        "message": "Allocation process started"
    }


@app.get("/allocation/{run_id}", response_model=AllocationResponse)
async def get_allocation_result(run_id: str):
    """Get the result of an allocation run"""
    if run_id not in allocation_runs:
        raise HTTPException(status_code=404, detail="Allocation run not found")

    run = allocation_runs[run_id]

    return AllocationResponse(
        run_id=run_id,
        status=run["status"],
        total_students=run.get("total_students", 0),
        allocated_students=run.get("allocated_students", 0),
        allocations=run.get("results", []),
        decision_logs=run.get("decision_logs", [])
    )


@app.get("/")
async def root():
    """Root endpoint with API information"""
    return {
        "name": "Hostel Allocation Engine",
        "version": "1.0.0",
        "docs": "/docs",
        "health": "/health"
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)
